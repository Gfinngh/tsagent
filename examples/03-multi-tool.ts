/**
 * 03 — Multiple tools
 *
 * Give the agent a mix of shipped tools and a custom one. The model
 * decides which to call and in what order. Demonstrates:
 *   - the shipped `calculator` and `greet` tools
 *   - a custom `time` tool built from `FunctionTool` and zod
 *   - the agent chaining tool calls in a single run
 *
 *   npx tsx examples/03-multi-tool.ts
 */

import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import { buildDefaultFallbackChain } from "../src/agent/runtime.js";
import { FunctionTool } from "../src/agent/tools/base.js";
import { calculatorTool } from "../src/agent/tools/calculator.js";
import { greetTool } from "../src/agent/tools/greet.js";
import { loadEnv, printFinal, printTrace } from "./_common.js";

loadEnv();

// A custom tool — this is all it takes to give the agent a new
// capability. The schema becomes the JSON Schema the model sees.
const timeTool = new FunctionTool({
    name: "get_time",
    description: "Return the current UTC time as an ISO 8601 string.",
    argsSchema: z.object({}),
    fn: () => new Date().toISOString(),
});

async function main(): Promise<void> {
    const agent = new Agent({
        llmClient: buildDefaultFallbackChain(),
        tools: [calculatorTool, greetTool, timeTool],
    });

    const prompt =
        'Greet Alice, tell me what time it is in UTC, and compute "10 * 4".';
    console.log(`→ ${prompt}\n`);
    const result = await agent.run(prompt);
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