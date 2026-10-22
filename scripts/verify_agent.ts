import { z } from "zod";
import { Agent, LlmCallError } from "../src/agent/agent.js";
import { FunctionTool } from "../src/agent/tools/base.js";
import {
    ScriptedClient,
    expectThrows,
    makeToolCall,
    textResponse,
    toolCallResponse,
    errorResponse,
} from "./_verify-agent.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(async () => {
    // ===== Simple text response (1 step) =====
    const client1 = new ScriptedClient([textResponse("hello")]);
    const agent1 = new Agent({ llmClient: client1, maxSteps: 3 });
    const result1 = await agent1.run("hi");

    checkEqual(result1.context.currentStep, 1, "text: one step");
    checkEqual(result1.stoppedByMaxSteps, false, "text: not stopped by max steps");
    check(result1.finalResult !== null, "text: finalResult set");
    if (result1.finalResult?.kind === "text") {
        checkEqual(result1.finalResult.text, "hello", "text: final answer matches");
    } else {
        check(false, "text: finalResult kind is 'text'");
    }
    checkEqual(client1.calls.length, 1, "text: one LLM call");

    // ===== Call 1 request shape =====
    const firstCall = client1.calls[0];
    checkEqual(
        firstCall?.events.length,
        1,
        "text: initial user event present",
    );
    const firstEvent = firstCall?.events[0];
    const firstItem = firstEvent?.content[0];
    checkEqual(firstItem?.type, "message", "text: first event item is message");
    if (firstItem?.type === "message") {
        checkEqual(firstItem.message.role, "user", "text: role is user");
        checkEqual(firstItem.message.content, "hi", "text: content matches");
    }
    checkEqual(firstCall?.toolChoice, undefined, "text: no toolChoice with no tools");

    // ===== Tool call then text (2 steps) =====
    const addTool = new FunctionTool({
        name: "add",
        description: "add",
        argsSchema: z.object({ a: z.number(), b: z.number() }),
        fn: ({ a, b }) => a + b,
    });
    const client2 = new ScriptedClient([
        toolCallResponse([makeToolCall("c1", "add", { a: 2, b: 3 })]),
        textResponse("5"),
    ]);
    const agent2 = new Agent({ llmClient: client2, tools: [addTool], maxSteps: 5 });
    const result2 = await agent2.run("add 2 and 3");

    checkEqual(result2.context.currentStep, 2, "tool: two steps");
    checkEqual(result2.stoppedByMaxSteps, false, "tool: not stopped");
    check(result2.finalResult?.kind === "text", "tool: finalResult is text");
    if (result2.finalResult?.kind === "text") {
        checkEqual(result2.finalResult.text, "5", "tool: final answer matches");
    }

    // ===== Tool result is in the events =====
    const toolResultEvent = result2.context.events.find((e) =>
        e.content.some((c) => c.type === "tool_result"),
    );
    check(toolResultEvent !== undefined, "tool: tool_result event present");
    const toolResultItem = toolResultEvent?.content.find(
        (c) => c.type === "tool_result",
    );
    if (toolResultItem?.type === "tool_result") {
        checkEqual(
            toolResultItem.toolResult.toolCallId,
            "c1",
            "tool: tool result toolCallId",
        );
        checkEqual(toolResultItem.toolResult.status, "success", "tool: success status");
        checkEqual(toolResultItem.toolResult.content, [5], "tool: content is [5]");
    }

    // ===== Second LLM call includes tool result =====
    const secondCall = client2.calls[1];
    check(secondCall !== undefined, "tool: second LLM call present");
    const toolMessages = secondCall?.events
        .flatMap((e) => e.content)
        .filter((c) => c.type === "tool_result") ?? [];
    checkEqual(toolMessages.length, 1, "tool: one tool_result event on second call");

    // ===== toolChoice "auto" when tools present =====
    checkEqual(client2.calls[0]?.toolChoice, "auto", "tool: toolChoice auto with tools");

    // ===== maxSteps respected =====
    const foreverTool = new FunctionTool({
        name: "forever",
        description: "always callable",
        argsSchema: z.object({}),
        fn: () => "ok",
    });
    const loopClient = new ScriptedClient([
        toolCallResponse([makeToolCall("c1", "forever")]),
        toolCallResponse([makeToolCall("c2", "forever")]),
        toolCallResponse([makeToolCall("c3", "forever")]),
    ]);
    const loopAgent = new Agent({
        llmClient: loopClient,
        tools: [foreverTool],
        maxSteps: 2,
    });
    const loopResult = await loopAgent.run("loop");

    checkEqual(loopResult.stoppedByMaxSteps, true, "maxSteps: stopped flag set");
    check(loopResult.finalResult === null, "maxSteps: no final result");
    checkEqual(loopResult.context.currentStep, 2, "maxSteps: currentStep = 2");

    // ===== LLM error -> LlmCallError =====
    const errClient = new ScriptedClient([errorResponse("boom")]);
    const errAgent = new Agent({ llmClient: errClient });
    await expectThrows(
        () => errAgent.run("x"),
        LlmCallError,
        "error: LLM error throws LlmCallError",
    );

    // ===== Empty LLM response =====
    const emptyClient = new ScriptedClient([textResponse("")]);
    const emptyAgent = new Agent({ llmClient: emptyClient });
    const emptyResult = await emptyAgent.run("x");
    checkEqual(
        emptyResult.finalResult !== null,
        true,
        "empty string: counts as text result (not null)",
    );

    // ===== textResponse with tool calls at once =====
    const mixClient = new ScriptedClient([
        toolCallResponse([makeToolCall("c1", "add", { a: 1, b: 1 })], "let me add"),
        textResponse("2"),
    ]);
    const mixAgent = new Agent({ llmClient: mixClient, tools: [addTool] });
    const mixResult = await mixAgent.run("add 1 and 1");
    checkEqual(mixResult.context.currentStep, 2, "mixed: two steps");
    check(mixResult.finalResult?.kind === "text", "mixed: text final result");
});