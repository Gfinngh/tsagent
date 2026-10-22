import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import { FunctionTool } from "../src/agent/tools/base.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(async () => {
    // ===== Two read tools run in parallel =====
    {
        const state = { current: 0, max: 0 };
        const makeRead = (name: string, id: number) =>
            new FunctionTool({
                name,
                description: name,
                argsSchema: z.object({}),
                fn: async () => {
                    state.current += 1;
                    state.max = Math.max(state.max, state.current);
                    await new Promise((r) => setTimeout(r, 40));
                    state.current -= 1;
                    return id;
                },
            });

        const client = new ScriptedClient([
            toolCallResponse([
                makeToolCall("c1", "read_a"),
                makeToolCall("c2", "read_b"),
            ]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [makeRead("read_a", 1), makeRead("read_b", 2)],
        });
        await agent.run("go");

        checkEqual(state.max, 2, "read batch: concurrency reached 2");
    }

    // ===== Mixed [read, mutate] runs sequentially =====
    {
        const state = { current: 0, max: 0 };
        const makeRead = (name: string, id: number) =>
            new FunctionTool({
                name,
                description: name,
                argsSchema: z.object({}),
                fn: async () => {
                    state.current += 1;
                    state.max = Math.max(state.max, state.current);
                    await new Promise((r) => setTimeout(r, 40));
                    state.current -= 1;
                    return id;
                },
            });
        const makeMutate = (name: string, id: number) =>
            new FunctionTool({
                name,
                description: name,
                permission: "mutate",
                argsSchema: z.object({}),
                fn: async () => {
                    state.current += 1;
                    state.max = Math.max(state.max, state.current);
                    await new Promise((r) => setTimeout(r, 40));
                    state.current -= 1;
                    return id;
                },
            });

        const client = new ScriptedClient([
            toolCallResponse([
                makeToolCall("c1", "read_a"),
                makeToolCall("c2", "mutate_a"),
            ]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [makeRead("read_a", 1), makeMutate("mutate_a", 2)],
            confirmToolCall: () => true,
        });
        await agent.run("go");

        checkEqual(state.max, 1, "read+mutate: concurrency stays at 1");
    }

    // ===== Order preserved even when read_b is slower =====
    {
        const slowRead = new FunctionTool({
            name: "read_slow",
            description: "slow",
            argsSchema: z.object({}),
            fn: async () => {
                await new Promise((r) => setTimeout(r, 60));
                return "slow_result";
            },
        });
        const fastRead = new FunctionTool({
            name: "read_fast",
            description: "fast",
            argsSchema: z.object({}),
            fn: () => "fast_result",
        });

        const client = new ScriptedClient([
            toolCallResponse([
                makeToolCall("c1", "read_slow"),
                makeToolCall("c2", "read_fast"),
            ]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [slowRead, fastRead],
        });
        const result = await agent.run("go");

        const toolResults = result.context.events
            .flatMap((e) => e.content)
            .filter((c) => c.type === "tool_result") as Array<{
                type: "tool_result";
                toolResult: { toolCallId: string; content: unknown[] };
            }>;
        checkEqual(toolResults.length, 2, "order: two tool results");
        checkEqual(toolResults[0]?.toolResult.toolCallId, "c1", "order: c1 first");
        checkEqual(toolResults[1]?.toolResult.toolCallId, "c2", "order: c2 second");
        checkEqual(
            toolResults[0]?.toolResult.content,
            ["slow_result"],
            "order: c1 content is slow_result",
        );
        checkEqual(
            toolResults[1]?.toolResult.content,
            ["fast_result"],
            "order: c2 content is fast_result",
        );
    }

    // ===== Three reads all run in parallel =====
    {
        const state = { current: 0, max: 0 };
        const makeRead = (name: string, id: number) =>
            new FunctionTool({
                name,
                description: name,
                argsSchema: z.object({}),
                fn: async () => {
                    state.current += 1;
                    state.max = Math.max(state.max, state.current);
                    await new Promise((r) => setTimeout(r, 30));
                    state.current -= 1;
                    return id;
                },
            });

        const client = new ScriptedClient([
            toolCallResponse([
                makeToolCall("c1", "read_a"),
                makeToolCall("c2", "read_b"),
                makeToolCall("c3", "read_c"),
            ]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [makeRead("read_a", 1), makeRead("read_b", 2), makeRead("read_c", 3)],
        });
        await agent.run("go");

        checkEqual(state.max, 3, "three reads: concurrency reached 3");
    }

    // ===== Single tool: no concurrency observed =====
    {
        const state = { current: 0, max: 0 };
        const oneRead = new FunctionTool({
            name: "read_one",
            description: "one",
            argsSchema: z.object({}),
            fn: async () => {
                state.current += 1;
                state.max = Math.max(state.max, state.current);
                await new Promise((r) => setTimeout(r, 20));
                state.current -= 1;
                return "ok";
            },
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "read_one")]),
            textResponse("done"),
        ]);
        const agent = new Agent({ llmClient: client, tools: [oneRead] });
        await agent.run("go");
        checkEqual(state.max, 1, "single read: concurrency stays at 1");
    }

    // ===== Denied calls never execute, even in a batch =====
    {
        const state = { calls: 0 };
        const deniedMutate = new FunctionTool({
            name: "denied_mutate",
            description: "denied",
            permission: "mutate",
            argsSchema: z.object({}),
            fn: () => {
                state.calls += 1;
                return "bad";
            },
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "denied_mutate")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [deniedMutate],
            // no confirmToolCall -> denied
        });
        await agent.run("go");
        checkEqual(state.calls, 0, "denied: never invoked");
    }
});