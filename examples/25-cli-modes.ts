/**
 * 25 — CLI usage
 *
 * The CLI (`main.ts`) is the primary way to run an agent from the
 * terminal. This example runs `main.ts --help` so you can see the full
 * flag interface, then documents each mode.
 *
 * Modes:
 *   fresh run        npm start -- "<prompt>"
 *   fresh with log   npm start -- --log runs/my-run.jsonl "<prompt>"
 *   resume           npm start -- --resume --log runs/my-run.jsonl
 *   resume + follow  npm start -- --resume --log runs/my-run.jsonl "<follow-up>"
 *   approvals        --approve | --deny  (mutually exclusive)
 *   dangerous tools  --allow-dangerous   (still needs an approval)
 *   model override   --model gemini-3.8-flash
 *   tracing off      --no-tracing
 *   max steps        --max-steps 5
 *
 * Exit codes:
 *   0  success
 *   1  LLM or MCP failure
 *   2  usage error
 *   3  quota exhausted
 *   130 interrupted (SIGINT, after graceful cleanup)
 *
 * Runs `--help` via a subprocess so the output is exactly what the user
 * would see. No LLM call.
 *
 *   npx tsx examples/25-cli-modes.ts
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { section } from "./_common.js";

async function main(): Promise<void> {
    section("`npm start -- --help` output");

    const mainTsPath = resolve("main.ts");
    const result = spawnSync(
        process.execPath,
        ["--import", "tsx", mainTsPath, "--help"],
        {
            encoding: "utf8",
            cwd: process.cwd(),
        },
    );
    if (typeof result.stdout === "string" && result.stdout.length > 0) {
        process.stdout.write(result.stdout);
    }
    if (result.status !== 0) {
        console.log(`(help exited with ${result.status})`);
    }

    section("common invocations");
    const examples = [
        ['npm start -- "What is 2 + 3?"', "fresh run, no persistence"],
        [
            'npm start -- --log runs/demo.jsonl "What is 2 + 3?"',
            "fresh run, persisted to runs/demo.jsonl",
        ],
        [
            "npm start -- --resume --log runs/demo.jsonl",
            "resume from a completed run (no-op if already complete)",
        ],
        [
            'npm start -- --resume --log runs/demo.jsonl "anything else?"',
            "resume with a follow-up message",
        ],
        [
            'npm start -- --approve "Write x to notes.txt"',
            "auto-approve all confirmations (mutate/dangerous)",
        ],
        [
            'npm start -- --deny "Write x to notes.txt"',
            "auto-deny all confirmations",
        ],
        [
            'npm start -- --allow-dangerous --approve "Run python: print(1)"',
            "unlock dangerous tools (still requires approval)",
        ],
        [
            'npm start -- --model gemini-3.8-flash "..."',
            "override the primary model (single-model, no fallback chain)",
        ],
        [
            'npm start -- --no-tracing "..."',
            "disable tracing entirely (no span emission)",
        ],
        ['npm start -- --max-steps 5 "..."', "cap the number of loop iterations"],
    ];
    for (const [cmd, note] of examples) {
        console.log(`  ${cmd}`);
        console.log(`    ${note}`);
    }

    section("environment variables that affect the CLI");
    const envVars: Array<[string, string]> = [
        ["TSAGENT_LOG_PATH", "default --log value (overridden by --log)"],
        ["WORKSPACE_ROOT", "root for the MCP file tools (default cwd)"],
        ["MCP_SERVER_COMMAND", "override the MCP server spawn command"],
        ["TSAGENT_MODEL_ORDER", "test | prod (see examples/20)"],
        ["TSAGENT_MEMORY_DB", "SQLite path for the memory store"],
        ["TSAGENT_MEMORY_PRUNE_DAYS", "auto-prune threshold (see examples/21)"],
        ["TAVILY_API_KEY", "required for `search_web` to work"],
        ["TSAGENT_DENO_PATH", "Deno executable for `execute_python`"],
        ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTLP trace exporter endpoint"],
        ["LANGFUSE_HOST", "Langfuse OTLP endpoint (alternative to OTLP_*)"],
    ];
    for (const [name, desc] of envVars) {
        console.log(`  ${name.padEnd(28)} ${desc}`);
    }

    section("notes");
    console.log(
        "The workflows have their own CLIs; see src/workflows/*.ts and the",
    );
    console.log(
        "`workflow:research-brief`, `workflow:iterative-brief`, `workflow:notes-digest`,",
    );
    console.log("and `workflow:trip-planner` npm scripts.");
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});