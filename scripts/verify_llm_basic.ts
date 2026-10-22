import { LlmClient, buildMessages, toolResultOutput } from "../src/agent/llm.js";
import {
    makeEvent,
    messageContentItem,
    toolCallContentItem,
    toolResultContentItem,
} from "../src/agent/schemas.js";
import { multipart, textPart, imagePart, structuredPart } from "../src/agent/tools/multipart.js";
import {
    ScriptedTransport,
    textResult,
    toolCallResult,
    toolDefinition,
} from "./_verify-llm.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(async () => {
    // ===== Happy path =====
    const transport = new ScriptedTransport([{ result: textResult("hello world") }]);
    const client = new LlmClient({ model: "test-model", transport });
    const res = await client.generate({
        instructions: ["You are helpful."],
        events: [makeEvent([messageContentItem({ role: "user", content: "hi" })])],
    });
    checkEqual(res.text, "hello world", "happy path: text matches");
    checkEqual(res.errorMessage, null, "happy path: no error");
    checkEqual(res.toolCalls.length, 0, "happy path: no tool calls");
    check(res.usage !== null, "happy path: usage present");
    checkEqual(res.usage?.promptTokens, 10, "happy path: promptTokens");
    checkEqual(res.errorMetadata.attempts, 1, "happy path: one attempt");

    // ===== Request capture: instructions become a system message =====
    let captured: unknown = null;
    const captureClient = new LlmClient({
        model: "m",
        transport: new ScriptedTransport([{ result: textResult("ok") }]),
        captureRequest: (payload) => {
            captured = payload;
        },
    });
    await captureClient.generate({
        instructions: ["A", "B", "C"],
        events: [],
    });
    const payload = captured as {
        messages: Array<{ role: string; content: string }>;
        mode: string;
    };
    checkEqual(payload.messages.length, 1, "capture: one system message");
    checkEqual(payload.messages[0]?.role, "system", "capture: role is system");
    checkEqual(
        payload.messages[0]?.content,
        "A\n\nB\n\nC",
        "capture: instructions joined by \\n\\n",
    );
    checkEqual(payload.mode, "chat", "capture: default mode is 'chat'");

    // ===== Capture: per-request mode override =====
    let capturedMode: string | null = null;
    const overrideClient = new LlmClient({
        model: "m",
        transport: new ScriptedTransport([{ result: textResult("ok") }]),
        mode: "chat",
        captureRequest: (p) => {
            capturedMode = p.mode;
        },
    });
    await overrideClient.generate({ instructions: [], events: [], mode: "structured" });
    checkEqual(capturedMode, "structured", "capture: per-request mode overrides default");

    // ===== Capture: tool definitions and toolChoice forwarded =====
    let capturedTools: unknown = null;
    let capturedChoice: unknown = null;
    const toolClient = new LlmClient({
        model: "m",
        transport: new ScriptedTransport([{ result: textResult("ok") }]),
        captureRequest: (p) => {
            capturedTools = p.tools;
            capturedChoice = p.toolChoice;
        },
    });
    await toolClient.generate({
        instructions: [],
        events: [],
        tools: [toolDefinition("add"), toolDefinition("greet")],
        toolChoice: "auto",
    });
    const toolsArr = capturedTools as Array<{ function: { name: string } }>;
    checkEqual(toolsArr.length, 2, "capture: both tool definitions forwarded");
    checkEqual(toolsArr[0]?.function.name, "add", "capture: first tool is add");
    checkEqual(toolsArr[1]?.function.name, "greet", "capture: second tool is greet");
    checkEqual(capturedChoice, "auto", "capture: toolChoice forwarded");

    // ===== Prompt building: user message round-trip =====
    const built = buildMessages(
        ["sys"],
        [makeEvent([messageContentItem({ role: "user", content: "hello" })])],
    );
    checkEqual(built.length, 2, "buildMessages: system + user");
    checkEqual(built[1]?.role, "user", "buildMessages: second is user");
    checkEqual((built[1] as { content: string }).content, "hello", "buildMessages: user content");

    // ===== Prompt building: consecutive tool calls merge into one assistant message =====
    const toolCallA = { id: "c1", name: "a", arguments: { x: 1 }, providerOptions: null };
    const toolCallB = { id: "c2", name: "b", arguments: { y: 2 }, providerOptions: null };
    const built2 = buildMessages(
        [],
        [
            makeEvent([messageContentItem({ role: "user", content: "go" })]),
            makeEvent([
                messageContentItem({ role: "assistant", content: null }),
                toolCallContentItem(toolCallA),
                toolCallContentItem(toolCallB),
            ]),
        ],
    );
    checkEqual(built2.length, 2, "buildMessages: user + assistant");
    const assistant = built2[1];
    checkEqual(assistant?.role, "assistant", "buildMessages: assistant role");
    const calls = (assistant as { toolCalls?: Array<{ id: string }> }).toolCalls ?? [];
    checkEqual(calls.length, 2, "buildMessages: two tool calls on one assistant");
    checkEqual(calls[0]?.id, "c1", "buildMessages: first call id");
    checkEqual(calls[1]?.id, "c2", "buildMessages: second call id");

    // ===== Prompt building: tool result becomes role:tool =====
    const built3 = buildMessages(
        [],
        [
            makeEvent([
                toolResultContentItem({
                    toolCallId: "c1",
                    name: "a",
                    content: [42],
                    status: "success",
                }),
            ]),
        ],
    );
    checkEqual(built3.length, 1, "buildMessages: one tool-result message");
    checkEqual(built3[0]?.role, "tool", "buildMessages: role is 'tool'");
    const tm = built3[0] as { toolCallId: string; name: string; content: string };
    checkEqual(tm.toolCallId, "c1", "buildMessages: toolCallId");
    checkEqual(tm.name, "a", "buildMessages: tool name");
    checkEqual(tm.content, "42", "buildMessages: tool content stringified");

    // ===== Prompt building: assistant message with providerOptions =====
    const built4 = buildMessages(
        [],
        [
            makeEvent([
                messageContentItem({
                    role: "assistant",
                    content: "hi",
                    providerOptions: { google: { sig: "abc" } },
                }),
            ]),
        ],
    );
    const asst = built4[0] as { providerOptions?: Record<string, unknown> };
    checkEqual(
        asst.providerOptions?.google,
        { sig: "abc" },
        "buildMessages: assistant providerOptions preserved",
    );

    // ===== toolResultOutput: single value =====
    checkEqual(toolResultOutput([42]), "42", "toolResultOutput: number");
    checkEqual(toolResultOutput(["hi"]), "hi", "toolResultOutput: string");
    checkEqual(toolResultOutput([true]), "true", "toolResultOutput: boolean");
    checkEqual(toolResultOutput([null]), "null", "toolResultOutput: null");

    // ===== toolResultOutput: multiple values joined by newline =====
    checkEqual(
        toolResultOutput(["a", "b", "c"]),
        "a\nb\nc",
        "toolResultOutput: multiple strings newline-joined",
    );
    checkEqual(
        toolResultOutput([42, "text", true]),
        "42\ntext\ntrue",
        "toolResultOutput: mixed scalars newline-joined",
    );

    // ===== toolResultOutput: structured JSON =====
    const structured = toolResultOutput([{ a: 1, b: [2, 3] }]);
    check(
        structured.includes('"a": 1') && structured.includes('"b"'),
        "toolResultOutput: structured object rendered as indented JSON",
    );

    // ===== toolResultOutput: multipart text =====
    const mpText = toolResultOutput([multipart([textPart("hello"), textPart("world")])]);
    checkEqual(
        mpText,
        "hello\nworld",
        "toolResultOutput: multipart text flattened to newline-joined",
    );

    // ===== toolResultOutput: multipart image =====
    const mpImage = toolResultOutput([
        multipart([imagePart("image/png", Buffer.from("test").toString("base64"))]),
    ]);
    check(
        mpImage.startsWith("[image: image/png, 4 bytes base64]"),
        "toolResultOutput: multipart image rendered as a placeholder tag",
    );

    // ===== toolResultOutput: multipart structured =====
    const mpStruct = toolResultOutput([multipart([structuredPart({ k: 1 })])]);
    check(mpStruct.includes('"k": 1'), "toolResultOutput: structured part rendered as JSON");

    // ===== toolResultOutput: mixed content =====
    const mixed = toolResultOutput([42, multipart([textPart("note")])]);
    checkEqual(mixed, "42\nnote", "toolResultOutput: mixed scalar + multipart joined");

    // ===== Transport receives the request =====
    const probeTransport = new ScriptedTransport([{ result: textResult("ok") }]);
    const probeClient = new LlmClient({ model: "m", transport: probeTransport });
    await probeClient.generate({
        instructions: ["i"],
        events: [],
        tools: [toolDefinition("x")],
        toolChoice: "required",
    });
    checkEqual(probeTransport.calls.length, 1, "transport: called exactly once");
    const call = probeTransport.calls[0];
    check(call?.messages !== undefined, "transport: received messages");
    checkEqual(call?.toolChoice, "required", "transport: received toolChoice");
    checkEqual(call?.tools?.[0]?.function.name, "x", "transport: received tools");
    checkEqual(call?.mode, "chat", "transport: received mode");

    // ===== Tool-call response preserved =====
    const toolTransport = new ScriptedTransport([
        {
            result: toolCallResult([
                { id: "c1", name: "add", arguments: { a: 1, b: 2 }, providerOptions: null },
            ]),
        },
    ]);
    const toolRespClient = new LlmClient({ model: "m", transport: toolTransport });
    const toolRes = await toolRespClient.generate({ instructions: [], events: [] });
    checkEqual(toolRes.toolCalls.length, 1, "tool response: one tool call");
    checkEqual(toolRes.toolCalls[0]?.id, "c1", "tool response: id");
    checkEqual(toolRes.toolCalls[0]?.name, "add", "tool response: name");
    checkEqual(toolRes.toolCalls[0]?.arguments, { a: 1, b: 2 }, "tool response: arguments");
});