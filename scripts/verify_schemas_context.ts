import {
    AgentEventSchema,
    ContentItemSchema,
    MessageSchema,
    MultipartContentSchema,
    ToolCallSchema,
    ToolResultSchema,
    makeEvent,
    messageContentItem,
    toolCallContentItem,
    toolResultContentItem,
} from "../src/agent/schemas.js";
import {
    ExecutionContext,
    deriveFinalResult,
    deriveStep,
} from "../src/agent/context.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(() => {
    // ===== Message =====
    const msg = MessageSchema.parse({ role: "user", content: "hello" });
    checkEqual(msg.role, "user", "Message: role");
    checkEqual(msg.content, "hello", "Message: content");
    checkEqual(msg.toolCalls, [], "Message: toolCalls defaults to []");
    checkEqual(msg.providerOptions, {}, "Message: providerOptions defaults to {}");
    check(
        !("toolCallId" in msg),
        "Message: toolCallId field is absent (removed from schema)",
    );

    let toolRoleRejected = false;
    try {
        MessageSchema.parse({ role: "tool", content: "x" });
    } catch {
        toolRoleRejected = true;
    }
    check(
        toolRoleRejected,
        "Message: role 'tool' rejected (only system/user/assistant)",
    );

    // ===== ToolCall =====
    const tc = ToolCallSchema.parse({
        id: "c1",
        name: "add",
        arguments: { a: 1, b: 2 },
    });
    checkEqual(tc.id, "c1", "ToolCall: id");
    checkEqual(tc.name, "add", "ToolCall: name");
    checkEqual(tc.providerOptions, null, "ToolCall: providerOptions defaults to null");

    const tcWithOpts = ToolCallSchema.parse({
        id: "c2",
        name: "x",
        arguments: {},
        providerOptions: { google: { thoughtSignature: "sig" } },
    });
    const opts = tcWithOpts.providerOptions as Record<string, unknown> | null;
    check(opts !== null, "ToolCall: providerOptions present");
    checkEqual(
        (opts as { google: unknown }).google,
        { thoughtSignature: "sig" },
        "ToolCall: providerOptions round-trip",
    );

    // ===== ToolResult =====
    const tr = ToolResultSchema.parse({
        toolCallId: "c1",
        name: "add",
        content: [3],
        status: "success",
    });
    checkEqual(tr.content, [3], "ToolResult: content");
    checkEqual(tr.status, "success", "ToolResult: status");

    // ===== ContentItem discriminated union =====
    const ciMsg = messageContentItem({ role: "assistant", content: "hi" });
    checkEqual(ciMsg.type, "message", "ContentItem: message type");
    const ciTc = toolCallContentItem(tc);
    checkEqual(ciTc.type, "tool_call", "ContentItem: tool_call type");
    const ciTr = toolResultContentItem(tr);
    checkEqual(ciTr.type, "tool_result", "ContentItem: tool_result type");

    let rejected = false;
    try {
        ContentItemSchema.parse({ type: "bogus" });
    } catch {
        rejected = true;
    }
    check(rejected, "ContentItem: rejects unknown discriminator");

    // ===== AgentEvent =====
    const ev = makeEvent([ciMsg]);
    check(ev.id.length > 0, "AgentEvent: id is non-empty");
    check(
        typeof ev.timestamp === "number" && ev.timestamp > 0,
        "AgentEvent: timestamp is positive",
    );
    checkEqual(ev.content.length, 1, "AgentEvent: content length");

    const evRoundTripped = AgentEventSchema.parse(JSON.parse(JSON.stringify(ev)));
    checkEqual(evRoundTripped.id, ev.id, "AgentEvent: round-trip preserves id");
    checkEqual(
        evRoundTripped.content[0]?.type,
        "message",
        "AgentEvent: round-trip preserves content kind",
    );

    // ===== MultipartContent =====
    const mpText = MultipartContentSchema.parse({
        type: "multipart",
        parts: [{ type: "text", text: "hi" }],
    });
    checkEqual(mpText.parts[0]?.type, "text", "MultipartContent: text part");

    const mpImage = MultipartContentSchema.parse({
        type: "multipart",
        parts: [{ type: "image", mimeType: "image/png", data: "base64" }],
    });
    checkEqual(mpImage.parts[0]?.type, "image", "MultipartContent: image part");

    const mpResource = MultipartContentSchema.parse({
        type: "multipart",
        parts: [{ type: "resource", uri: "file:///x", text: "hi" }],
    });
    checkEqual(mpResource.parts[0]?.type, "resource", "MultipartContent: resource part");

    const mpStructured = MultipartContentSchema.parse({
        type: "multipart",
        parts: [{ type: "structured", data: { a: 1 } }],
    });
    checkEqual(
        mpStructured.parts[0]?.type,
        "structured",
        "MultipartContent: structured part",
    );

    // ===== ExecutionContext: step derivation =====

    const assistantMsg = messageContentItem({ role: "assistant", content: "hi" });
    const assistantWithToolCall = messageContentItem({ role: "assistant", content: null });
    const toolResultItem = toolResultContentItem(tr);
    const toolCallItem = toolCallContentItem(tc);

    // Single assistant message → step 1
    const ctx1 = new ExecutionContext([makeEvent([assistantMsg])]);
    checkEqual(ctx1.currentStep, 1, "step: assistant message counts as 1 step");

    // Single tool_result event → step 0
    const ctx2 = new ExecutionContext([makeEvent([toolResultItem])]);
    checkEqual(ctx2.currentStep, 0, "step: tool_result event alone does NOT count");

    // Two full cycles → step 2
    const ctx3 = new ExecutionContext([
        makeEvent([assistantWithToolCall, toolCallItem]),
        makeEvent([toolResultItem]),
        makeEvent([
            assistantWithToolCall,
            toolCallContentItem({ id: "c3", name: "y", arguments: {} }),
        ]),
        makeEvent([toolResultItem]),
    ]);
    checkEqual(ctx3.currentStep, 2, "step: two full cycles = 2 steps");

    // Empty context → 0
    const ctx4 = new ExecutionContext();
    checkEqual(ctx4.currentStep, 0, "step: empty context = 0");

    // addEvent updates step
    ctx4.addEvent(makeEvent([assistantMsg]));
    checkEqual(ctx4.currentStep, 1, "step: addEvent updates currentStep");
    checkEqual(ctx4.events.length, 1, "step: addEvent appends to events");

    // ===== deriveFinalResult: free-form =====

    const fr1 = deriveFinalResult([makeEvent([assistantMsg])], undefined);
    check(fr1 !== null, "finalResult: free-form detected");
    if (fr1?.kind === "text") {
        checkEqual(fr1.text, "hi", "finalResult: free-form text value");
    } else {
        check(false, "finalResult: free-form kind is 'text'");
    }

    check(
        deriveFinalResult([makeEvent([toolCallItem])], undefined) === null,
        "finalResult: null when last event has tool_call",
    );

    // ===== deriveFinalResult: structured =====

    const finalAnswerResult = toolResultContentItem({
        toolCallId: "cf",
        name: "final_answer",
        content: [{ output: { x: 42 } }],
        status: "success",
    });
    const structuredEvent = makeEvent([finalAnswerResult]);

    const fr3 = deriveFinalResult([structuredEvent], "final_answer");
    check(fr3 !== null, "finalResult: structured detected with outputToolName");
    if (fr3?.kind === "structured") {
        checkEqual(fr3.output, { x: 42 }, "finalResult: structured unwraps {output}");
    } else {
        check(false, "finalResult: structured kind is 'structured'");
    }

    check(
        deriveFinalResult([structuredEvent], undefined) === null,
        "finalResult: null for structured run without outputToolName",
    );

    // ===== ExecutionContext.finalResult honors outputToolName =====

    const ctx5 = new ExecutionContext([structuredEvent], "final_answer");
    check(ctx5.isFinished, "ctx.isFinished: true for structured run w/ outputToolName");
    if (ctx5.finalResult?.kind === "structured") {
        checkEqual(ctx5.finalResult.output, { x: 42 }, "ctx.finalResult: unwraps output");
    }

    const ctx6 = new ExecutionContext([structuredEvent]);
    check(
        !ctx6.isFinished,
        "ctx.isFinished: false for structured run without outputToolName",
    );

    // ===== deriveStep free function =====

    checkEqual(deriveStep([]), 0, "deriveStep: empty = 0");
    checkEqual(
        deriveStep([makeEvent([assistantMsg])]),
        1,
        "deriveStep: single assistant = 1",
    );

    // ===== Non-wrapped structured content passes through =====
    const bare = toolResultContentItem({
        toolCallId: "cf2",
        name: "final_answer",
        content: [{ a: 1, b: 2 }],
        status: "success",
    });
    const fr5 = deriveFinalResult([makeEvent([bare])], "final_answer");
    if (fr5?.kind === "structured") {
        checkEqual(fr5.output, { a: 1, b: 2 }, "finalResult: non-wrapped object passed through");
    } else {
        check(false, "finalResult: non-wrapped object still structured");
    }
});