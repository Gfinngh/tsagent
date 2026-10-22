import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BaseTool, FunctionTool, ToolError } from "./base.js";

/**
 * Pyodide version pinned by the sandbox. Bump deliberately; the value is
 * baked into the Deno-side import URL. Cache invalidation on upgrade is
 * handled by Deno's `--cached-only` warm-up: a new version triggers a
 * fresh fetch on the first run after the bump.
 */
const PYODIDE_VERSION = "0.26.2";

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
const WARMUP_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 16_384;

export interface ExecutePythonOptions {
    /** Overrides `TSAGENT_DENO_PATH` or the `deno` binary on PATH. */
    denoPath?: string;
    /** Overrides the default 60s warm-up budget (tests use a longer value). */
    warmupTimeoutMs?: number;
}

/**
 * Sandboxed Python execution via Deno + Pyodide.
 *
 * Environment isolation: the child process is spawned with ONLY a small
 * allowlist of OS-level vars (`DENO_DIR`, `HOME`, `PATH`, `TMPDIR`,
 * platform lib paths). API keys, tokens, and application vars are
 * stripped. Pyodide reads the Deno process env to populate
 * `os.environ`, so this allowlist is what keeps host secrets out of the
 * sandbox.
 *
 * Sandbox guarantees:
 * - **`--cached-only`** — no network fetches at run time (cache is
 *   warmed once on first call).
 * - **`--allow-read=<npm_cache>`** — the Emscripten runtime can read its
 *   own WASM files; nothing else is readable.
 * - **No `--allow-net`, `--allow-env`, `--allow-run`, `--allow-ffi`,
 *   `--allow-write`** — the child has no network, no environment, no
 *   subprocess, no FFI, no filesystem writes. User Python code cannot
 *   escape.
 *
 * Output truncated at 16 KiB. Caller timeouts clamped to `[1s, 30s]`.
 * Warm-up memoized: runs once per process on the first call.
 * `execute_python` carries `permission: "dangerous"` — the two-lock
 * model applies on top.
 */
export function makeExecutePythonTool(
    options: ExecutePythonOptions = {},
): BaseTool {
    return new FunctionTool({
        name: "execute_python",
        description:
            "Run Python code in an isolated Deno/Pyodide sandbox. No network, " +
            "no filesystem writes, no environment access. Output is truncated at " +
            "16 KiB.",
        permission: "dangerous",
        argsSchema: z.object({
            code: z.string().min(1),
            timeoutMs: z.number().int().positive().optional(),
        }),
        fn: async ({ code, timeoutMs }) => {
            const clamped = clampTimeout(timeoutMs ?? DEFAULT_TIMEOUT_MS);
            const denoPath = resolveNonEmpty(
                options.denoPath,
                process.env.TSAGENT_DENO_PATH,
            ) ?? "deno";
            await ensureWarmup(
                denoPath,
                options.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS,
            );
            const result = await runDeno({
                denoPath,
                scriptPath: getSandboxScriptPath(),
                input: JSON.stringify({ code }),
                cachedOnly: true,
                allowNet: false,
                timeoutMs: clamped,
            });
            if (result.error !== null) {
                throw new ToolError(result.error);
            }
            const combined = [result.stdout, result.stderr]
                .filter((s) => s.length > 0)
                .join("\n");
            return truncateOutput(combined);
        },
    });
}

function resolveNonEmpty(
    ...values: Array<string | undefined>
): string | undefined {
    for (const value of values) {
        if (value !== undefined && value !== "") return value;
    }
    return undefined;
}

// =========================================================================
// Warm-up (memoized)
// =========================================================================

let warmupPromise: Promise<void> | null = null;

async function ensureWarmup(
    denoPath: string,
    timeoutMs: number,
): Promise<void> {
    if (warmupPromise !== null) return warmupPromise;
    warmupPromise = (async () => {
        try {
            await runDeno({
                denoPath,
                scriptPath: getSandboxScriptPath(),
                input: JSON.stringify({ code: "pass" }),
                cachedOnly: false,
                allowNet: true,
                timeoutMs,
            });
        } catch (error) {
            warmupPromise = null;
            throw error;
        }
    })();
    return warmupPromise;
}

// =========================================================================
// Sandbox script
// =========================================================================

let sandboxScriptPath: string | null = null;

function getSandboxScriptPath(): string {
    if (sandboxScriptPath !== null) return sandboxScriptPath;
    const dir = mkdtempSync(join(tmpdir(), "tsagent-sandbox-"));
    const scriptPath = join(dir, "sandbox.ts");
    writeFileSync(scriptPath, SANDBOX_SCRIPT, "utf8");
    sandboxScriptPath = scriptPath;
    process.on("exit", () => {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* best effort */
        }
    });
    return scriptPath;
}

// The sandbox script is TypeScript, run under Deno. It reads
// `{ code: string }` from stdin as JSON, runs the code via Pyodide with
// stdout/stderr captured, and writes `{ stdout, stderr, error }` to stdout.
const SANDBOX_SCRIPT = `import { loadPyodide } from "npm:pyodide@${PYODIDE_VERSION}";

async function readStdin() {
  const chunks = [];
  const reader = Deno.stdin.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(combined);
}

let input;
try {
  input = JSON.parse(await readStdin());
} catch (e) {
  console.log(JSON.stringify({ stdout: "", stderr: "invalid input: " + String(e), error: null }));
  Deno.exit(0);
}

const out = [];
const errLines = [];
let error = null;

try {
  const pyodide = await loadPyodide();
  pyodide.setStdout({ batched: (line) => out.push(line) });
  pyodide.setStderr({ batched: (line) => errLines.push(line) });
  await pyodide.runPythonAsync(input.code);
} catch (e) {
  error = String(e);
}

console.log(JSON.stringify({
  stdout: out.join("\\n"),
  stderr: errLines.join("\\n"),
  error,
}));
`;

// =========================================================================
// Deno subprocess
// =========================================================================

interface DenoRunOptions {
    denoPath: string;
    scriptPath: string;
    input: string;
    cachedOnly: boolean;
    allowNet: boolean;
    timeoutMs: number;
}

interface DenoResult {
    stdout: string;
    stderr: string;
    error: string | null;
}

/**
 * Spawn Deno with a minimal environment.
 *
 * Only OS-level vars that Deno and Emscripten/Pyodide genuinely need are
 * forwarded: `DENO_DIR` (module cache; required by `--cached-only`),
 * `HOME` (Emscripten defaults, config lookups), `PATH` (Deno internal
 * subprocesses), `TMPDIR` (Pyodide init temp files), platform library
 * paths. Everything else — API keys, tokens, application vars — is
 * stripped.
 */
function runDeno(opts: DenoRunOptions): Promise<DenoResult> {
    return new Promise((resolve, reject) => {
        if (opts.denoPath === "") {
            reject(new ToolError("deno path resolved to empty string"));
            return;
        }

        const args: string[] = ["run"];
        if (opts.cachedOnly) args.push("--cached-only");
        if (opts.allowNet) args.push("--allow-net");
        args.push(`--allow-read=${computeNpmCache()}`);
        args.push(opts.scriptPath);

        const child = spawn(opts.denoPath, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: buildChildEnv(),
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, opts.timeoutMs);

        child.on("error", (error) => {
            clearTimeout(timer);
            reject(
                new ToolError(
                    `failed to spawn deno at "${opts.denoPath}": ${error.message}`,
                ),
            );
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new ToolError(`sandbox timed out after ${opts.timeoutMs}ms`));
                return;
            }
            const stdout = Buffer.concat(stdoutChunks).toString("utf8");
            const stderr = Buffer.concat(stderrChunks).toString("utf8");
            if (code !== 0) {
                reject(
                    new ToolError(
                        `sandbox exited with code ${code}: ${(stderr || stdout).slice(0, 500)}`,
                    ),
                );
                return;
            }
            const lastLine =
                stdout
                    .trim()
                    .split("\n")
                    .filter((line) => line.length > 0)
                    .pop() ?? "";
            try {
                const parsed = JSON.parse(lastLine) as DenoResult;
                resolve(parsed);
            } catch {
                reject(
                    new ToolError(
                        `sandbox produced invalid output: ${stdout.slice(0, 500)}`,
                    ),
                );
            }
        });

        try {
            child.stdin?.write(opts.input);
            child.stdin?.end();
        } catch (error) {
            clearTimeout(timer);
            reject(
                new ToolError(
                    `failed to write to sandbox stdin: ${(error as Error).message}`,
                ),
            );
        }
    });
}

// =========================================================================
// Helpers
// =========================================================================

function buildChildEnv(): Record<string, string> {
    const env: Record<string, string> = {
        DENO_DIR: computeDenoDir(),
    };
    for (const key of [
        "HOME",
        "PATH",
        "TMPDIR",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
    ] as const) {
        const value = process.env[key];
        if (value !== undefined && value !== "") env[key] = value;
    }
    return env;
}

function clampTimeout(ms: number): number {
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, ms));
}

function truncateOutput(text: string): string {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= MAX_OUTPUT_BYTES) return text;
    const slice = Buffer.from(text, "utf8")
        .subarray(0, MAX_OUTPUT_BYTES)
        .toString("utf8");
    return `${slice}\n[truncated: ${bytes - MAX_OUTPUT_BYTES} more bytes]`;
}

function computeDenoDir(): string {
    return resolveNonEmpty(process.env.DENO_DIR) ?? defaultDenoDir();
}

function computeNpmCache(): string {
    return join(computeDenoDir(), "npm");
}

function defaultDenoDir(): string {
    const home = homedir();
    if (process.platform === "win32") {
        return join(home, "AppData", "Local", "deno");
    }
    if (process.platform === "darwin") {
        return join(home, "Library", "Caches", "deno");
    }
    return join(home, ".cache", "deno");
}