/**
 * Verification: SIGINT cleanup.
 *
 * The invariant: when SIGINT fires during a live run, the process must
 * (a) exit 130, (b) print a clear "interrupted" message, and (c) NOT
 * leave an orphaned MCP subprocess behind.
 *
 * Why "no orphan" is the load-bearing check: the pre-fix handler used
 * `process.exit(130)` directly from the signal handler, which skipped
 * every `finally` block. The MCP child (spawned with `stdio: inherit`)
 * was reparented to init and kept running. The fix plumbs an
 * `AbortController` through the run path so `finally` blocks execute.
 *
 * How the test is deterministic: it polls for the log file to appear
 * (which means the MCP subprocess is up and `agent.run` has appended
 * at least one event), waits 3s, then sends SIGINT. The prompt forces
 * four sequential `search_web` calls, so the run is guaranteed to still
 * be in progress at the 3s mark.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    check,
    checkEqual,
    makeTempDir,
    runScript,
    skip,
} from "./_verify-common.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const mainTsPath = join(projectRoot, "main.ts");

const SIGINT_PROMPT =
    "Use the search_web tool to search for 'TypeScript history', then " +
    "'TypeScript adoption', then 'TypeScript roadmap', then " +
    "'TypeScript performance'. Do each search as a separate step. " +
    "Report the top result of each search.";

/**
 * Count `node --import tsx src/agent/server.ts` subprocesses. Used to
 * detect orphans left behind by a broken SIGINT path. Falls back to 0
 * if `pgrep` is unavailable (Windows, or a minimal container).
 */
function countMcpServerProcesses(): number {
    try {
        const result = spawnSync(
            "pgrep",
            ["-f", "tsx.*src/agent/server.ts"],
            { encoding: "utf8" },
        );
        if (result.status !== 0) return 0;
        return result.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "").length;
    } catch {
        return 0;
    }
}

function waitForExit(
    child: ChildProcess,
    timeoutMs: number,
): Promise<number> {
    if (child.exitCode !== null) {
        return Promise.resolve(child.exitCode);
    }
    return new Promise<number>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(-1), timeoutMs);
        child.once("exit", (code) => {
            clearTimeout(timer);
            resolvePromise(code ?? -1);
        });
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

runScript(async () => {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (apiKey === undefined || apiKey === "") {
        skip("sigint: no GEMINI_API_KEY (needed for a live run)");
        return;
    }
    const tavilyKey = process.env.TAVILY_API_KEY;
    if (tavilyKey === undefined || tavilyKey === "") {
        skip(
            "sigint: no TAVILY_API_KEY (needed to force a slow, tool-driven run)",
        );
        return;
    }

    const tmp = makeTempDir("sigint");
    // `spawned` is a local const so TypeScript preserves the non-null
    // narrowing across the `await` boundaries inside the polling loop.
    // `child` remains mutable so the `finally` block can still kill a
    // still-running process even if an exception escapes before we would
    // otherwise have a chance to clean up.
    let spawned: ChildProcess | null = null;
    try {
        const logPath = join(tmp.path, "run.jsonl");

        const beforeCount = countMcpServerProcesses();

        const proc = spawn(
            process.execPath,
            [
                "--import",
                "tsx",
                mainTsPath,
                "--approve",
                "--log",
                logPath,
                SIGINT_PROMPT,
            ],
            {
                cwd: projectRoot,
                stdio: ["pipe", "pipe", "pipe"],
                env: { ...process.env },
            },
        );
        spawned = proc;

        let stderr = "";
        let stdout = "";
        proc.stderr?.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        proc.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        // Poll for the log to appear. The log is created by the first
        // `log.append(event)` inside `agent.run`, which fires after the
        // MCP connection is established and the run has begun. Its
        // existence is a reliable signal that we are past MCP spawn and
        // into the agent loop.
        const spawnDeadline = Date.now() + 30_000;
        let logAppeared = false;
        while (Date.now() < spawnDeadline) {
            if (existsSync(logPath)) {
                logAppeared = true;
                break;
            }
            await sleep(100);
        }

        if (!logAppeared) {
            proc.kill("SIGKILL");
            check(false, "sigint: run did not start within 30s");
            return;
        }
        check(true, "sigint: run started (log file appeared)");

        // Let the run get into the middle of a search_web round-trip.
        await sleep(3000);

        // If the run already completed (unexpected — the prompt forces
        // four serial search calls), this test cannot assert SIGINT
        // behavior. Report that clearly rather than a false pass.
        if (proc.exitCode !== null) {
            check(
                false,
                `sigint: run completed before SIGINT was delivered (exit=${proc.exitCode}); increase the sleep budget or check the prompt`,
            );
            return;
        }

        // Deliver SIGINT.
        proc.kill("SIGINT");

        const exitCode = await waitForExit(proc, 60_000);

        if (exitCode === -1) {
            check(false, "sigint: process did not exit within 60s of SIGINT");
            proc.kill("SIGKILL");
            return;
        }

        checkEqual(exitCode, 130, "sigint: exit code is 130");
        check(
            stderr.includes("[tsagent] interrupted"),
            `sigint: interrupted message present (tail: ${JSON.stringify(stderr.slice(-160))})`,
        );
        check(
            !stderr.includes("unhandled"),
            "sigint: no unhandled promise rejections",
        );
        void stdout;

        // Give the MCP child a moment to notice stdin closed and exit on
        // its own. The SDK's transport closes stdin during cleanup, and the
        // server exits when its read side hits EOF.
        await sleep(1500);

        const afterCount = countMcpServerProcesses();
        check(
            afterCount <= beforeCount,
            `sigint: no orphaned MCP server (before=${beforeCount}, after=${afterCount})`,
        );

        // If cleanup skipped the log close, we might see a partial record.
        // Parse the log defensively and confirm every line is valid JSON.
        if (existsSync(logPath)) {
            const { readFileSync } = await import("node:fs");
            const content = readFileSync(logPath, "utf8");
            const lines = content.split("\n").filter((l) => l !== "");
            let allValid = true;
            for (const line of lines) {
                try {
                    JSON.parse(line);
                } catch {
                    allValid = false;
                    break;
                }
            }
            check(
                allValid,
                `sigint: log is well-formed (${lines.length} lines parsed)`,
            );
        }
    } finally {
        if (spawned !== null && spawned.exitCode === null) {
            try {
                spawned.kill("SIGKILL");
            } catch {
                // ignore
            }
        }
        tmp.cleanup();
    }
});