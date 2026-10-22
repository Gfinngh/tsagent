/**
 * 15 — Python sandbox
 *
 * `execute_python` runs user-supplied Python inside Deno + Pyodide
 * with no network, no filesystem writes, no environment access, and no
 * subprocess spawning. The two-lock model applies on top: it is
 * `permission: "dangerous"`, so it needs `allowDangerous` and a
 * confirm callback to run.
 *
 * This example calls the tool directly (no agent). Requires Deno to be
 * installed; skips cleanly otherwise.
 *
 *   npx tsx examples/15-execute-python.ts
 */

import { spawnSync } from "node:child_process";
import { makeExecutePythonTool } from "../src/agent/tools/python.js";
import { loadEnv, section } from "./_common.js";

loadEnv();

function denoAvailable(path: string): boolean {
    try {
        const result = spawnSync(path, ["--version"], { timeout: 3000 });
        return result.status === 0;
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    const denoPath = process.env.TSAGENT_DENO_PATH ?? "deno";
    if (!denoAvailable(denoPath)) {
        section("skipped");
        console.log(
            `deno is not available at "${denoPath}". Install Deno or set TSAGENT_DENO_PATH.`,
        );
        return;
    }

    const tool = makeExecutePythonTool();
    console.log(
        "first run warms up Pyodide (may take 30–60s); subsequent runs are fast.",
    );

    section('print(1 + 1)');
    {
        const result = await tool.run({ code: "print(1 + 1)" });
        console.log(`  → ${result.map(String).join(" | ")}`);
    }

    section("multi-line code");
    {
        const code = ["for i in range(3):", "    print(i)"].join("\n");
        const result = await tool.run({ code });
        console.log("  →");
        for (const line of String(result[0]).split("\n")) {
            console.log(`    ${line}`);
        }
    }

    section("uncaught exception → error surfaced");
    {
        try {
            await tool.run({ code: 'raise ValueError("boom")' });
        } catch (error) {
            console.log(
                `  → error: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    section("environment isolation");
    {
        const code = [
            "import os",
            'print("HOME" in os.environ)',
            'print("GEMINI_API_KEY" in os.environ)',
        ].join("\n");
        const result = await tool.run({ code });
        console.log("  → HOME in os.environ:        " + String(result[0]).split("\n")[0]);
        console.log("  → GEMINI_API_KEY in os.environ: " + String(result[0]).split("\n")[1]);
        console.log("  (secrets do not leak into the sandbox)");
    }

    section("notes");
    console.log("timeoutMs is clamped to [1000, 30000].");
    console.log("output is truncated at 16 KiB with a marker.");
    console.log("permission tier: dangerous — the agent will not run it without two locks.");
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});