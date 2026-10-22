import { spawnSync } from "node:child_process";
import { McpConnection } from "../src/agent/client.js";
import { makeExecutePythonTool } from "../src/agent/tools/python.js";
import { makeTempDir, runScript, skip } from "./_verify-common.js";
import { check, checkEqual } from "./_verify-common.js";

function denoAvailable(denoPath: string): boolean {
    try {
        const result = spawnSync(denoPath, ["--version"], { timeout: 3000 });
        return result.status === 0;
    } catch {
        return false;
    }
}

/**
 * Canary value placed in the parent process env before spawning the MCP
 * server. The MCP server inherits it (it needs the full parent env for
 * TAVILY_API_KEY and friends). `execute_python` then spawns Deno with a
 * minimal allowlist that excludes the canary. If the canary appears in
 * Pyodide's `os.environ`, the sandbox has leaked host environment
 * variables into user code.
 */
const CANARY = "tsagent-canary-8f4e2a1c-not-a-secret";

runScript(async () => {
    // Source-level check: execute_python MUST be dangerous.
    {
        const tool = makeExecutePythonTool();
        checkEqual(
            tool.permission,
            "dangerous",
            "execute_python: permission is dangerous",
        );
        checkEqual(
            tool.concurrencySafe,
            false,
            "execute_python: not concurrency-safe",
        );
    }

    const denoPath = process.env.TSAGENT_DENO_PATH ?? "deno";
    if (!denoAvailable(denoPath)) {
        skip(`deno unavailable at '${denoPath}' — skipping sandbox runtime tests`);
        return;
    }

    // Set the canary in the parent env so it flows into the MCP server
    // subprocess (which inherits process.env). It must NOT reach the Deno
    // subprocess, which uses a restricted env allowlist.
    const originalCanary = process.env.TSAGENT_TEST_CANARY;
    process.env.TSAGENT_TEST_CANARY = CANARY;

    const tmp = makeTempDir("exec-python");
    try {
        const conn = new McpConnection("tsagent", {
            command: process.execPath,
            args: ["--import", "tsx", "src/agent/server.ts"],
            env: { WORKSPACE_ROOT: tmp.path },
            connectTimeoutMs: 30_000,
        });

        try {
            await conn.connect();

            // ----- Warm-up (first call pays the cache/load cost) -----
            // Fail loudly on error, not skip — an installed-Deno warm-up
            // failure is a real bug, not an environmental precondition.
            {
                const warmup = await conn.callTool("execute_python", { code: "1 + 1" });
                if (warmup.isError === true) {
                    const msg = (warmup.content[0] as { text: string }).text;
                    check(false, `warmup: tool reported error: ${msg}`);
                    return;
                }
                check(true, "warmup: succeeded");
            }

            // ----- Basic print -----
            {
                const r = await conn.callTool("execute_python", {
                    code: "print(1 + 1)",
                });
                checkEqual(r.isError, false, "basic: isError false");
                const text = (r.content[0] as { text: string }).text;
                checkEqual(text, "2", "basic: output '2'");
            }

            // ----- Multi-line -----
            {
                const r = await conn.callTool("execute_python", {
                    code: "for i in range(3):\n    print(i)",
                });
                const text = (r.content[0] as { text: string }).text;
                checkEqual(text, "0\n1\n2", "multi-line: three lines");
            }

            // ----- Error propagation -----
            {
                const r = await conn.callTool("execute_python", {
                    code: 'raise ValueError("boom")',
                });
                checkEqual(r.isError, true, "error: isError true");
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.includes("ValueError") && text.includes("boom"),
                    "error: exception surfaced",
                );
            }

            // ----- Output truncation (>16 KiB) -----
            {
                const r = await conn.callTool("execute_python", {
                    code: 'print("x" * 20000)',
                });
                checkEqual(r.isError, false, "truncation: isError false");
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.length <= 16_384 + 200,
                    `truncation: output capped (${text.length} chars)`,
                );
                check(text.includes("[truncated:"), "truncation: marker present");
            }

            // ----- Timeout: infinite loop killed -----
            //
            // `conn.callTool` returns `{ isError: true }` for tool errors — it
            // does not throw. Inspect the result rather than wrapping in
            // try/catch, or a successful "the tool returned" will be misread
            // as "the tool did not error".
            {
                const start = Date.now();
                const r = await conn.callTool("execute_python", {
                    code: "while True:\n    pass",
                    timeoutMs: 1500,
                });
                const elapsed = Date.now() - start;
                checkEqual(r.isError, true, "timeout: isError true");
                check(
                    elapsed < 10_000,
                    `timeout: killed within budget (${elapsed}ms)`,
                );
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.toLowerCase().includes("timed out"),
                    "timeout: message mentions timed out",
                );
            }

            // ----- Environment isolation: canary must NOT leak -----
            //
            // The canary is present in the MCP server's env (inherited from
            // process.env). Deno is spawned with a restricted env allowlist
            // that excludes it. If Pyodide's os.environ contains the canary,
            // host secrets would leak into user Python code.
            {
                const r = await conn.callTool("execute_python", {
                    code: `import os\nprint("TSAGENT_TEST_CANARY" in os.environ)`,
                });
                const text = (r.content[0] as { text: string }).text;
                checkEqual(
                    text,
                    "False",
                    "isolation: canary not in os.environ",
                );
            }
        } finally {
            await conn.close();
        }
    } finally {
        // Restore original canary state.
        if (originalCanary === undefined) {
            delete process.env.TSAGENT_TEST_CANARY;
        } else {
            process.env.TSAGENT_TEST_CANARY = originalCanary;
        }
        tmp.cleanup();
    }
});