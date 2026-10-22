/**
 * 04 — Structured output
 *
 * Constrain the model to return a JSON object matching a zod schema
 * instead of free-form text. The agent adds a `final_answer` tool whose
 * `inputSchema` is `{ output: <your schema> }`, and forces the model to
 * call it. You get back a validated object.
 *
 *   npx tsx examples/04-structured-output.ts
 */

import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import { buildDefaultFallbackChain } from "../src/agent/runtime.js";
import { loadEnv, printFinal } from "./_common.js";

loadEnv();

const CityFacts = z.object({
    city: z.string(),
    country: z.string(),
    population: z.number().int().positive(),
    notable_landmark: z.string(),
});

async function main(): Promise<void> {
    const agent = new Agent({
        llmClient: buildDefaultFallbackChain(),
        outputType: CityFacts,
    });

    console.log('→ "Give me basic facts about Tokyo as a structured object."\n');
    const result = await agent.run(
        "Give me basic facts about Tokyo as a structured object.",
    );

    console.log("--- final answer (structured) ---");
    printFinal(result);

    if (result.finalResult?.kind === "structured") {
        const parsed = CityFacts.safeParse(result.finalResult.output);
        console.log(`\nvalidated against schema: ${parsed.success ? "✓" : "✗"}`);
    }
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});