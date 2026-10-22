/**
 * 11 — Per-tool timeouts
 *
 * Each tool can carry a `timeoutMs`. The agent races the tool against
 * a timer; if the timer wins, the tool is aborted and a `ToolResult`
 * with `errorKind: "timeout"` is returned. The run continues; the
 * model sees the timeout and can react.
 *
 * Uses `ScriptedClient` so the outcome is deterministic.
 *
 *   npx tsx examples/11-tool-timeouts.ts
 */

import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import { FunctionTool } from "../src/agent/tools/base.js";
import {
    collectToolResults,
    loadEnv,
    printFinal,
    printTrace,
    section,
} from "./_common.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_fakes.js";

loadEnv();

async function main(): Promise<void> {
    section("a tool that exceeds its per-call timeout");

    const slowTool = new FunctionTool({
        name: "slow",
        description: "Sleeps for 500 ms; times out at 50 ms.",
        timeoutMs: 50,
        argsSchema: z.object({}),
        fn: (_args, signal) =>
            new Promise<string>((resolve, reject) => {
                const timer = setTimeout(() => resolve("slow finished"), 500);
                if (signal === undefined) return;
                signal.addEventListener(
                    "abort",
                    () => {
                        clearTimeout(timer);
                        const err = new Error("aborted");
                        err.name = "AbortError";
                        reject(err);
                    },
                    { once: true },
                );
            }),
    });

    const client = new ScriptedClient([
        toolCallResponse([makeToolCall("c1", "slow")]),
        textResponse("the tool timed out, moving on"),
    ]);

    const agent = new Agent({
        llmClient: client,
        tools: [slowTool],
        maxSteps: 3,
    });

    const start = Date.now();
    const result = await agent.run("go");
    const elapsed = Date.now() - start;

    printTrace(result);
    section("outcome");
    const toolResults = collectToolResults(result);
    const toolResult = toolResults[0];
    if (toolResult !== undefined) {
        console.log(`status:    ${toolResult.status}`);
        console.log(`errorKind: ${toolResult.errorKind ?? "null"}`);
        console.log(`message:   ${String(toolResult.content[0])}`);
    }
    console.log(`wall time: ~${elapsed}ms (should be close to the 50ms timeout)`);

    section("final answer");
    printFinal(result);

    section("notes");
    console.log(
        "If the outer run has its own runTimeoutMs and that fires first,",
    );
    console.log(
        "the agent throws AgentTimeoutError instead of returning a tool result.",
    );
    console.log("See src/agent/agent.ts for the exact precedence rules.");
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});