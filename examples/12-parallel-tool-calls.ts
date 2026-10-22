/**
 * 12 — Concurrency in the tool batch
 *
 * When a batch of tool calls all have `concurrencySafe: true` (the
 * default for `read`-tier tools), the agent runs them in parallel.
 * One `concurrencySafe: false` tool in the batch forces the whole
 * batch to run sequentially. Order of results is always preserved to
 * match the emitted call order.
 *
 * This example measures wall time for both shapes so you can see the
 * difference concretely. Uses `ScriptedClient` so timing is
 * reproducible.
 *
 *   npx tsx examples/12-parallel-tool-calls.ts
 */

import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import { FunctionTool } from "../src/agent/tools/base.js";
import {
    loadEnv,
    section,
} from "./_common.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_fakes.js";

loadEnv();

function makeSleeper(name: string, permission: "read" | "mutate") {
    return new FunctionTool({
        name,
        description: `Sleeps 200 ms and returns "${name} done".`,
        permission,
        argsSchema: z.object({}),
        fn: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return `${name} done`;
        },
    });
}

async function timeRun(
    label: string,
    permission: "read" | "mutate",
): Promise<number> {
    const tools = [
        makeSleeper("a", permission),
        makeSleeper("b", permission),
        makeSleeper("c", permission),
    ];
    const client = new ScriptedClient([
        toolCallResponse([
            makeToolCall("c1", "a"),
            makeToolCall("c2", "b"),
            makeToolCall("c3", "c"),
        ]),
        textResponse("done"),
    ]);
    const agent = new Agent({
        llmClient: client,
        tools,
        ...(permission === "mutate"
            ? { confirmToolCall: async () => true }
            : {}),
    });
    const start = Date.now();
    await agent.run("go");
    const elapsed = Date.now() - start;
    section(label);
    console.log(`  wall time: ~${elapsed}ms`);
    return elapsed;
}

async function main(): Promise<void> {
    console.log(
        "Three tools, each sleeps 200 ms. All-read vs all-mutate " +
        "should differ in wall time.",
    );

    const parallelMs = await timeRun("all read (concurrencySafe → parallel)", "read");
    const sequentialMs = await timeRun(
        "all mutate (not concurrencySafe → sequential)",
        "mutate",
    );

    section("interpretation");
    console.log(
        `parallel:   ~${parallelMs}ms  (should be ≈ 200ms)`,
    );
    console.log(
        `sequential: ~${sequentialMs}ms (should be ≈ 600ms, 3 × 200ms)`,
    );
    console.log(
        "\nYou can opt a `mutate` tool into parallel by setting `concurrencySafe: true`",
    );
    console.log(
        "in its constructor — do so only when the tool is truly safe to run concurrently.",
    );
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});