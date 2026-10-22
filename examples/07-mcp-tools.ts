/**
 * 07 — MCP tools
 *
 * Load the MCP server's tool catalog and call tools directly. Shows
 * that the tools exist independently of any LLM — you can drive them
 * yourself if you want, or hand them to an Agent (every other example
 * shows that path).
 *
 *   npx tsx examples/07-mcp-tools.ts
 */

import { join } from "node:path";
import { loadMcpTools } from "../src/agent/client.js";
import { spawnMcpConnection } from "../src/agent/runtime.js";
import { ensureDir, loadEnv } from "./_common.js";

loadEnv();

const EXAMPLES_DIR = ".examples";
const WORKSPACE_DIR = join(EXAMPLES_DIR, "workspace");

async function main(): Promise<void> {
    ensureDir(WORKSPACE_DIR);

    const connection = await spawnMcpConnection({
        workspaceRoot: WORKSPACE_DIR,
    });

    try {
        const tools = await loadMcpTools(connection);
        console.log(`--- ${tools.length} tools available ---`);
        for (const tool of tools) {
            console.log(
                `  ${tool.name.padEnd(18)} [${tool.permission}] — ${tool.description.split("\n")[0]}`,
            );
        }

        // Call the calculator directly, without an LLM in the loop.
        const calculator = tools.find((t) => t.name === "calculator");
        if (calculator !== undefined) {
            console.log('\n--- calling calculator("2 + 3") directly ---');
            const result = await calculator.run({ expression: "2 + 3" });
            console.log(`  → ${result.map(String).join(" | ")}`);
        }

        // The greet tool, same pattern.
        const greet = tools.find((t) => t.name === "greet");
        if (greet !== undefined) {
            console.log('\n--- calling greet({ name: "Alice" }) directly ---');
            const result = await greet.run({ name: "Alice" });
            console.log(`  → ${result.map(String).join(" | ")}`);
        }

        console.log(
            "\nAny of these tools can be passed to `new Agent({ tools })` to let the model use them.",
        );
    } finally {
        await connection.close();
    }
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});