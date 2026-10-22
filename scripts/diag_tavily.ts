/**
 * Diagnostic: exercise `search_web` directly, bypassing the MCP layer,
 * so we can see exactly what Tavily returned and whether the key reached
 * the process.
 *
 * Run with:
 *   npx tsx scripts/diag_tavily.ts
 *
 * The key itself is never printed. Only its length, so the operator can
 * confirm the env var reached this process without a fingerprint of the
 * key value becoming part of shared diagnostic output.
 */

import { config as loadEnv } from "dotenv";

loadEnv();

import { makeSearchWebTool } from "../src/agent/tools/search.js";

async function main(): Promise<void> {
    const key = process.env.TAVILY_API_KEY;
    if (key === undefined) {
        process.stdout.write("TAVILY_API_KEY: undefined\n");
    } else if (key === "") {
        process.stdout.write("TAVILY_API_KEY: empty string\n");
    } else {
        process.stdout.write(`TAVILY_API_KEY: present (length=${key.length})\n`);
    }

    const tool = makeSearchWebTool();
    process.stdout.write("\nCalling search_web({ query: 'TypeScript 5.0 release date' })...\n\n");

    try {
        const result = await tool.run({ query: "TypeScript 5.0 release date" });
        process.stdout.write("RESULT:\n");
        console.dir(result, { depth: 6 });
    } catch (error) {
        process.stderr.write(
            `ERROR: ${error instanceof Error ? error.message : String(error)}\n`,
        );
    }
}

main().catch((error) => {
    process.stderr.write(
        `fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
});