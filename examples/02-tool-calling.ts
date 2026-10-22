/**
 * 02 — Tool calling
 *
 * Give the agent a single tool. Watch it invoke `calculator` and use
 * the result to answer. Demonstrates the tool-call round trip: model
 * emits a call → agent runs the tool → result goes back to the model
 * → model produces a final answer.
 *
 *   npx tsx examples/02-tool-calling.ts
 */

import { Agent } from "../src/agent/agent.js";
import { buildDefaultFallbackChain } from "../src/agent/runtime.js";
import { calculatorTool } from "../src/agent/tools/calculator.js";
import { loadEnv, printFinal, printTrace } from "./_common.js";

loadEnv();

async function main(): Promise<void> {
    const agent = new Agent({
        llmClient: buildDefaultFallbackChain(),
        tools: [calculatorTool],
    });

    console.log('→ Use the calculator tool to compute "2 + 3", then tell me the answer.\n');
    const result = await agent.run(
        'Use the calculator tool to compute "2 + 3", then tell me the answer.',
    );
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