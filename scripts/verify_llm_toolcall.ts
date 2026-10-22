import { LlmClient, buildMessages, toolResultOutput } from "../src/agent/llm.js";
import {
    makeEvent,
    messageContentItem,
    toolCallContentItem,
    toolResultContentItem,
} from "../src/agent/schemas.js";
import {
    decodeThoughtId,
    encodeThoughtId,
    extractThoughtSignature,
    isDummySignature,
    unwrapLegacyProviderFields,
    withThoughtSignature,
    DUMMY_SIGNATURE_KEY,
} from "../src/agent/provider-options.js";
import { ScriptedTransport, toolCallResult, textResult } from "./_verify-llm.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(async () => {
    // ===== Provider options: unwrap legacy {"google": {...}} =====
    checkEqual(
        unwrapLegacyProviderFields({ google: { sig: "abc" } }),
        { sig: "abc" },
        "unwrapLegacyProviderFields: single google key unwrapped",
    );
    checkEqual(
        unwrapLegacyProviderFields({ sig: "abc" }),
        { sig: "abc" },
        "unwrapLegacyProviderFields: flat dict left untouched",
    );
    checkEqual(
        unwrapLegacyProviderFields({ google: { sig: "abc" }, other: 1 }),
        { google: { sig: "abc" }, other: 1 },
        "unwrapLegacyProviderFields: multi-key dict left untouched",
    );
    checkEqual(
        unwrapLegacyProviderFields(null),
        null,
        "unwrapLegacyProviderFields: null passthrough",
    );
    checkEqual(
        unwrapLegacyProviderFields(undefined),
        null,
        "unwrapLegacyProviderFields: undefined -> null",
    );

    // ===== isDummySignature =====
    check(isDummySignature(DUMMY_SIGNATURE_KEY), "isDummySignature: literal string is dummy");
    check(isDummySignature(true), "isDummySignature: boolean true is dummy");
    check(!isDummySignature("real_signature"), "isDummySignature: real signature is not dummy");
    check(!isDummySignature(42), "isDummySignature: number is not dummy");
    check(!isDummySignature(null), "isDummySignature: null is not dummy");

    // ===== extractThoughtSignature =====
    checkEqual(
        extractThoughtSignature({ thought_signature: "real" }),
        "real",
        "extractThoughtSignature: real signature returned",
    );
    checkEqual(
        extractThoughtSignature({ [DUMMY_SIGNATURE_KEY]: true }),
        null,
        "extractThoughtSignature: dummy returns null",
    );
    checkEqual(
        extractThoughtSignature({ [DUMMY_SIGNATURE_KEY]: DUMMY_SIGNATURE_KEY }),
        null,
        "extractThoughtSignature: literal dummy string returns null",
    );
    checkEqual(
        extractThoughtSignature({ google: { thought_signature: "wrapped" } }),
        "wrapped",
        "extractThoughtSignature: legacy wrapped shape unwrapped",
    );
    checkEqual(
        extractThoughtSignature(null),
        null,
        "extractThoughtSignature: null -> null",
    );

    // ===== withThoughtSignature =====
    checkEqual(
        withThoughtSignature(null, "sig"),
        { thought_signature: "sig" },
        "withThoughtSignature: from null creates flat dict",
    );
    checkEqual(
        withThoughtSignature({ other: 1 }, "sig"),
        { other: 1, thought_signature: "sig" },
        "withThoughtSignature: preserves other keys",
    );
    checkEqual(
        withThoughtSignature({ google: { sig: "old" } }, "new"),
        { sig: "old", thought_signature: "new" },
        "withThoughtSignature: unwraps legacy before setting",
    );

    // ===== encode/decode thought id =====
    const encoded = encodeThoughtId("call_123", "sig_abc");
    checkEqual(encoded, "call_123__thought__sig_abc", "encodeThoughtId: format");
    const decoded = decodeThoughtId(encoded);
    check(decoded !== null, "decodeThoughtId: suffix present");
    checkEqual(decoded?.baseId, "call_123", "decodeThoughtId: base id");
    checkEqual(decoded?.signature, "sig_abc", "decodeThoughtId: signature");
    checkEqual(decodeThoughtId("plain_id"), null, "decodeThoughtId: no suffix returns null");

    // ===== Tool call with providerOptions preserved through prompt building =====
    const built = buildMessages(
        [],
        [
            makeEvent([
                messageContentItem({ role: "assistant", content: null }),
                toolCallContentItem({
                    id: "c1",
                    name: "add",
                    arguments: { a: 1, b: 2 },
                    providerOptions: { thought_signature: "sig_xyz" },
                }),
            ]),
        ],
    );
    const asst = built[0];
    checkEqual(asst?.role, "assistant", "prompt: assistant role");
    const toolCall = (asst as { toolCalls: Array<{ providerOptions?: unknown }> }).toolCalls[0];
    const opts = toolCall?.providerOptions as Record<string, unknown> | null | undefined;
    checkEqual(
        opts?.thought_signature,
        "sig_xyz",
        "prompt: providerOptions preserved on tool call",
    );

    // ===== Tool result round-trip through toolResultOutput =====
    const built2 = buildMessages(
        [],
        [
            makeEvent([
                toolResultContentItem({
                    toolCallId: "c1",
                    name: "add",
                    content: [
                        {
                            type: "multipart",
                            parts: [
                                { type: "text", text: "line1" },
                                { type: "structured", data: { result: 3 } },
                            ],
                        },
                    ],
                    status: "success",
                }),
            ]),
        ],
    );
    const toolMsg = built2[0] as { content: string };
    check(
        toolMsg.content.includes("line1"),
        "prompt: multipart text survives stringification",
    );
    check(
        toolMsg.content.includes('"result": 3'),
        "prompt: multipart structured survives stringification",
    );

    // ===== End-to-end: tool-call response is returned =====
    const transport = new ScriptedTransport([
        {
            result: toolCallResult([
                {
                    id: "call_1",
                    name: "add",
                    arguments: { a: 5, b: 7 },
                    providerOptions: { thought_signature: "sig1" },
                },
            ]),
        },
    ]);
    const client = new LlmClient({ model: "m", transport });
    const response = await client.generate({ instructions: [], events: [] });
    checkEqual(response.toolCalls.length, 1, "e2e: one tool call");
    checkEqual(response.toolCalls[0]?.arguments, { a: 5, b: 7 }, "e2e: arguments intact");
    checkEqual(
        (response.toolCalls[0]?.providerOptions as Record<string, unknown> | null)
            ?.thought_signature,
        "sig1",
        "e2e: providerOptions survive",
    );

    // ===== Text response with no tool calls =====
    const textTransport = new ScriptedTransport([{ result: textResult("done") }]);
    const textClient = new LlmClient({ model: "m", transport: textTransport });
    const textResp = await textClient.generate({ instructions: [], events: [] });
    checkEqual(textResp.text, "done", "text response: text");
    checkEqual(textResp.toolCalls.length, 0, "text response: no tool calls");

    // ===== toolResultOutput: image with explicit mime type =====
    // A well-formed MultipartContent with a valid image part renders as a
    // placeholder tag carrying the mime type and the decoded byte length.
    const imageWithMime = toolResultOutput([
        {
            type: "multipart",
            parts: [
                {
                    type: "image",
                    mimeType: "image/jpeg",
                    data: Buffer.from("xy").toString("base64"),
                },
            ],
        },
    ]);
    check(
        imageWithMime.startsWith("[image: image/jpeg, 2 bytes base64]"),
        "toolResultOutput: image with explicit mimeType renders correctly",
    );

    // ===== toolResultOutput: malformed image part is JSON-stringified =====
    // MultipartContent is a strict, well-formed type — ImagePart requires
    // mimeType. A dict shaped like multipart but missing required fields
    // does NOT count as multipart; it falls through to JSON stringification
    // so that every byte of the input is preserved rather than fabricated
    // into a placeholder tag. The application/octet-stream default lives at
    // the MCP conversion boundary (mcpResultToMultipart), not here.
    const imageNoMime = toolResultOutput([
        {
            type: "multipart",
            parts: [{ type: "image", data: Buffer.from("x").toString("base64") }],
        },
    ]);
    check(
        imageNoMime.includes('"type": "image"'),
        "toolResultOutput: malformed image part is JSON-stringified",
    );
    check(
        !imageNoMime.includes("[image:"),
        "toolResultOutput: malformed image part does NOT produce an image tag",
    );
    check(
        imageNoMime.includes(Buffer.from("x").toString("base64")),
        "toolResultOutput: malformed image data is preserved verbatim",
    );

});