import { z } from "zod";
import {
    Agent,
    detectResumeState,
    findPendingToolCalls,
} from "../src/agent/agent.js";
import { ExecutionContext } from "../src/agent/context.js";
import {
    FunctionTool,
    type BaseTool,
} from "../src/agent/tools/base.js";
import {
    makeEvent,
    messageContentItem,
    toolCallContentItem,
    toolResultContentItem,
} from "../src/agent/schemas.js";
import {
    ScriptedClient,
    expectThrows,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

function addTool(counter: { calls: number }): BaseTool {
    return new FunctionTool({
        name: "add",
        description: "add",
        argsSchema: z.object({ a: z.number(), b: z.number() }),
        fn: ({ a, b }) => {
            counter.calls += 1;
            return a + b;
        },
    });
}

function makeCompletedText(): ExecutionContext {
    const ctx = new ExecutionContext([]);
    ctx.addEvent(makeEvent([messageContentItem({ role: "user", content: "hi" })]));
    ctx.addEvent(makeEvent([messageContentItem({ role: "assistant", content: "hello" })]));
    return ctx;
}

function makeCompletedStructured(): ExecutionContext {
    const ctx = new ExecutionContext([], "final_answer");
    ctx.addEvent(makeEvent([messageContentItem({ role: "user", content: "go" })]));
    ctx.addEvent(
        makeEvent([
            messageContentItem({ role: "assistant", content: null }),
            toolCallContentItem({
                id: "c1",
                name: "final_answer",
                arguments: { output: { answer: "first", confidence: 1 } },
                providerOptions: null,
            }),
        ]),
    );
    ctx.addEvent(
        makeEvent([
            toolResultContentItem({
                toolCallId: "c1",
                name: "final_answer",
                content: [{ output: { answer: "first", confidence: 1 } }],
                status: "success",
            }),
        ]),
    );
    return ctx;
}

function makePendingToolContext(): ExecutionContext {
    const ctx = new ExecutionContext([]);
    ctx.addEvent(makeEvent([messageContentItem({ role: "user", content: "go" })]));
    ctx.addEvent(
        makeEvent([
            messageContentItem({ role: "assistant", content: null }),
            toolCallContentItem({
                id: "c1",
                name: "add",
                arguments: { a: 2, b: 3 },
                providerOptions: null,
            }),
        ]),
    );
    return ctx;
}

function makePendingFinalContext(): ExecutionContext {
    const ctx = new ExecutionContext([]);
    ctx.addEvent(makeEvent([messageContentItem({ role: "user", content: "go" })]));
    ctx.addEvent(
        makeEvent([
            messageContentItem({ role: "assistant", content: null }),
            toolCallContentItem({
                id: "c1",
                name: "add",
                arguments: { a: 2, b: 3 },
                providerOptions: null,
            }),
        ]),
    );
    ctx.addEvent(
        makeEvent([
            toolResultContentItem({
                toolCallId: "c1",
                name: "add",
                content: [5],
                status: "success",
            }),
        ]),
    );
    return ctx;
}

runScript(async () => {
    const OutputSchema = z.object({ answer: z.string(), confidence: z.number() });

    // ===== detectResumeState pure helper =====
    checkEqual(
        detectResumeState(makeCompletedText()),
        "complete",
        "detectResumeState: completed text is 'complete'",
    );
    checkEqual(
        detectResumeState(makeCompletedStructured()),
        "complete",
        "detectResumeState: completed structured is 'complete'",
    );
    checkEqual(
        detectResumeState(makePendingToolContext()),
        "pendingTool",
        "detectResumeState: pending tool call is 'pendingTool'",
    );
    checkEqual(
        detectResumeState(makePendingFinalContext()),
        "pendingFinal",
        "detectResumeState: pending final is 'pendingFinal'",
    );

    // ===== findPendingToolCalls pure helper =====
    {
        const ctx = makePendingToolContext();
        const pending = findPendingToolCalls(ctx.events);
        checkEqual(pending.length, 1, "findPendingToolCalls: one pending");
        checkEqual(pending[0]?.id, "c1", "findPendingToolCalls: id is c1");
    }
    {
        const ctx = makePendingFinalContext();
        checkEqual(
            findPendingToolCalls(ctx.events).length,
            0,
            "findPendingToolCalls: none when tool result present",
        );
    }

    // ===== State A: complete text + no follow-up -> no-op =====
    {
        const ctx = makeCompletedText();
        const initialEventCount = ctx.events.length;
        const client = new ScriptedClient([]); // would throw if called
        const agent = new Agent({ llmClient: client });
        const result = await agent.resume(ctx);

        checkEqual(client.calls.length, 0, "stateA/no-follow-up: no LLM call");
        checkEqual(ctx.events.length, initialEventCount, "stateA/no-follow-up: no events appended");
        checkEqual(result.finalResult?.kind, "text", "stateA/no-follow-up: same final result");
        checkEqual(result.stoppedByMaxSteps, false, "stateA/no-follow-up: not stopped by max");
        checkEqual(result.usage, null, "stateA/no-follow-up: usage null");
    }

    // ===== State A: complete text + follow-up -> new turn =====
    {
        const ctx = makeCompletedText();
        const client = new ScriptedClient([textResponse("second reply")]);
        const agent = new Agent({ llmClient: client });
        const result = await agent.resume(ctx, { userMessage: "another" });

        checkEqual(client.calls.length, 1, "stateA/follow-up: one LLM call");
        checkEqual(result.finalResult?.kind, "text", "stateA/follow-up: text final");
        if (result.finalResult?.kind === "text") {
            checkEqual(
                result.finalResult.text,
                "second reply",
                "stateA/follow-up: new final answer",
            );
        }
        const userEvents = result.context.events.filter((e) =>
            e.content.some(
                (c) => c.type === "message" && c.message.role === "user",
            ),
        );
        checkEqual(userEvents.length, 2, "stateA/follow-up: two user events");
    }

    // ===== State A: complete structured + follow-up -> new structured turn =====
    {
        const ctx = makeCompletedStructured();
        const client = new ScriptedClient([
            toolCallResponse([
                makeToolCall("c2", "final_answer", {
                    output: { answer: "second", confidence: 0.8 },
                }),
            ]),
        ]);
        const agent = new Agent({ llmClient: client, outputType: OutputSchema });
        const result = await agent.resume(ctx, { userMessage: "another" });

        checkEqual(client.calls.length, 1, "stateA/follow-up+structured: one LLM call");
        checkEqual(
            result.finalResult?.kind,
            "structured",
            "stateA/follow-up+structured: structured result",
        );
        if (result.finalResult?.kind === "structured") {
            checkEqual(
                result.finalResult.output,
                { answer: "second", confidence: 0.8 },
                "stateA/follow-up+structured: new output, not old",
            );
            checkEqual(
                result.finalResult.toolCallId,
                "c2",
                "stateA/follow-up+structured: new toolCallId",
            );
        }
    }

    // ===== State B: pending tool call -> execute + continue =====
    {
        const counter = { calls: 0 };
        const ctx = makePendingToolContext();
        const client = new ScriptedClient([textResponse("five")]);
        const agent = new Agent({
            llmClient: client,
            tools: [addTool(counter)],
        });
        const result = await agent.resume(ctx);

        checkEqual(counter.calls, 1, "stateB: pending tool executed once");
        checkEqual(client.calls.length, 1, "stateB: one follow-up LLM call");
        checkEqual(result.finalResult?.kind, "text", "stateB: text final result");

        const toolResults = result.context.events
            .flatMap((e) => e.content)
            .filter((c) => c.type === "tool_result") as Array<{
                type: "tool_result";
                toolResult: { toolCallId: string; content: unknown[]; status: string };
            }>;
        checkEqual(toolResults.length, 1, "stateB: one recovery tool_result event");
        checkEqual(toolResults[0]?.toolResult.content, [5], "stateB: recovery result is [5]");
        checkEqual(toolResults[0]?.toolResult.status, "success", "stateB: recovery status success");
    }

    // ===== State B: mixed (one resolved, one pending) -> only pending executes =====
    {
        const c1Calls = { calls: 0 };
        const c2Calls = { calls: 0 };
        const c1 = new FunctionTool({
            name: "c1",
            description: "c1",
            argsSchema: z.object({}),
            fn: () => {
                c1Calls.calls += 1;
                return "c1-done";
            },
        });
        const c2 = new FunctionTool({
            name: "c2",
            description: "c2",
            argsSchema: z.object({}),
            fn: () => {
                c2Calls.calls += 1;
                return "c2-done";
            },
        });

        const ctx = new ExecutionContext([]);
        ctx.addEvent(makeEvent([messageContentItem({ role: "user", content: "go" })]));
        ctx.addEvent(
            makeEvent([
                messageContentItem({ role: "assistant", content: null }),
                toolCallContentItem({ id: "call_c1", name: "c1", arguments: {}, providerOptions: null }),
                toolCallContentItem({ id: "call_c2", name: "c2", arguments: {}, providerOptions: null }),
            ]),
        );
        ctx.addEvent(
            makeEvent([
                toolResultContentItem({
                    toolCallId: "call_c1",
                    name: "c1",
                    content: ["already"],
                    status: "success",
                }),
            ]),
        );

        const client = new ScriptedClient([textResponse("done")]);
        const agent = new Agent({ llmClient: client, tools: [c1, c2] });
        await agent.resume(ctx);

        checkEqual(c1Calls.calls, 0, "stateB/mixed: c1 NOT re-executed");
        checkEqual(c2Calls.calls, 1, "stateB/mixed: c2 executed once");
    }

    // ===== State B: follow-up message rejected =====
    {
        const counter = { calls: 0 };
        const ctx = makePendingToolContext();
        const client = new ScriptedClient([]);
        const agent = new Agent({
            llmClient: client,
            tools: [addTool(counter)],
        });
        await expectThrows(
            () => agent.resume(ctx, { userMessage: "pivot" }),
            Error,
            "stateB/follow-up: rejects follow-up while tools pending",
        );
        checkEqual(counter.calls, 0, "stateB/follow-up: pending tool NOT executed");
    }

    // ===== State C: pending final -> one LLM call =====
    {
        const ctx = makePendingFinalContext();
        const client = new ScriptedClient([textResponse("the answer is 5")]);
        const agent = new Agent({ llmClient: client });
        const result = await agent.resume(ctx);

        checkEqual(client.calls.length, 1, "stateC: one LLM call");
        checkEqual(result.finalResult?.kind, "text", "stateC: text final");
        if (result.finalResult?.kind === "text") {
            checkEqual(
                result.finalResult.text,
                "the answer is 5",
                "stateC: final text matches",
            );
        }
    }

    // ===== Empty context: throws =====
    {
        const ctx = new ExecutionContext([]);
        const client = new ScriptedClient([]);
        const agent = new Agent({ llmClient: client });
        await expectThrows(
            () => agent.resume(ctx),
            Error,
            "empty-context: resume throws",
        );
        checkEqual(client.calls.length, 0, "empty-context: no LLM call");
    }

    // ===== maxSteps respected in resume =====
    {
        const foreverTool = new FunctionTool({
            name: "forever",
            description: "always callable",
            argsSchema: z.object({}),
            fn: () => "ok",
        });
        const ctx = makePendingFinalContext();
        // Already at step 1 (one assistant event). maxSteps=1 means we cannot
        // take another step.
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c2", "forever")]),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [foreverTool],
            maxSteps: 1,
        });
        const result = await agent.resume(ctx);

        checkEqual(result.stoppedByMaxSteps, true, "stateC/maxSteps=1: stopped");
        checkEqual(client.calls.length, 0, "stateC/maxSteps=1: no LLM call");
    }
});