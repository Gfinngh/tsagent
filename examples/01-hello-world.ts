/**
 * 01 — Hello world
 *
 * The smallest possible agent: one user message, one LLM call, one
 * text response. No tools, no structured output, no persistence.
 *
 *   npx tsx examples/01-hello-world.ts
 */

import { Agent } from "../src/agent/agent.js";
import { buildDefaultFallbackChain } from "../src/agent/runtime.js";
import { loadEnv, printFinal, printTrace } from "./_common.js";

loadEnv();

async function main(): Promise<void> {
    const agent = new Agent({
        llmClient: buildDefaultFallbackChain(),
    });

    console.log('→ Say "hello" and nothing else.\n');
    const result = await agent.run('Say "hello" and nothing else.');
    console.log("--- trace ---");
    printTrace(result);
    console.log("\n--- final answer ---");
    printFinal(result);
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});