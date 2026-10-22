import { LlmClient, type LlmClientProtocol } from "../src/agent/llm.js";
import {
    ScriptedStreamTransport,
    TransportError,
    isTransientLlmError,
    toolDefinition,
} from "./_verify-llm.js";
import { makeToolCall } from "./_verify-agent.js";
import {
    makeEvent,
    messageContentItem,
} from "../src/agent/schemas.js";
import { check, checkEqual, runScript, skip } from "./_verify-common.js";

runScript(async () => {
    // ===== Streaming text + tool call together =====
    {
        const deltas: string[] = [];
        const transport = new ScriptedStreamTransport([
            {
                chunks: ["Let me ", "check."],
                toolCalls: [makeToolCall("c1", "add", { a: 1, b: 2 })],
            },
        ]);
        const client = new LlmClient({ model: "m", transport });
        const response = await client.generate({
            instructions: [],
            events: [],
            tools: [toolDefinition("add")],
            toolChoice: "auto",
            onTextDelta: (delta) => deltas.push(delta),
        });
        checkEqual(deltas, ["Let me ", "check."], "stream-tool/text: deltas in order");
        checkEqual(response.text, "Let me check.", "stream-tool/text: accumulated text");
        checkEqual(response.toolCalls.length, 1, "stream-tool/text: one tool call");
        checkEqual(response.toolCalls[0]?.id, "c1", "stream-tool/text: id preserved");
        checkEqual(
            response.toolCalls[0]?.arguments,
            { a: 1, b: 2 },
            "stream-tool/text: arguments parsed as object",
        );
    }

    // ===== Tool call only, no text =====
    {
        const transport = new ScriptedStreamTransport([
            { chunks: [], toolCalls: [makeToolCall("c1", "x", { y: 1 })] },
        ]);
        const client = new LlmClient({ model: "m", transport });
        const response = await client.generate({
            instructions: [],
            events: [],
            tools: [toolDefinition("x")],
            onTextDelta: () => { },
        });
        checkEqual(response.text, null, "stream-tool/only: text null");
        checkEqual(response.toolCalls.length, 1, "stream-tool/only: tool call preserved");
    }

    // ===== Multiple tool calls in one stream =====
    {
        const transport = new ScriptedStreamTransport([
            {
                chunks: [],
                toolCalls: [
                    makeToolCall("c1", "a", {}),
                    makeToolCall("c2", "b", {}),
                ],
            },
        ]);
        const client = new LlmClient({ model: "m", transport });
        const response = await client.generate({
            instructions: [],
            events: [],
            tools: [toolDefinition("a"), toolDefinition("b")],
            onTextDelta: () => { },
        });
        checkEqual(response.toolCalls.length, 2, "stream-tool/multi: two tool calls");
        checkEqual(response.toolCalls[0]?.id, "c1", "stream-tool/multi: first id");
        checkEqual(response.toolCalls[1]?.id, "c2", "stream-tool/multi: second id");
    }

    // ===== Tool call providerOptions preserved =====
    {
        const transport = new ScriptedStreamTransport([
            {
                chunks: [],
                toolCalls: [
                    {
                        id: "c1",
                        name: "x",
                        arguments: {},
                        providerOptions: { thought_signature: "sig1" },
                    },
                ],
            },
        ]);
        const client = new LlmClient({ model: "m", transport });
        const response = await client.generate({
            instructions: [],
            events: [],
            tools: [toolDefinition("x")],
            onTextDelta: () => { },
        });
        const opts = response.toolCalls[0]?.providerOptions as
            | Record<string, unknown>
            | null
            | undefined;
        checkEqual(
            opts?.thought_signature,
            "sig1",
            "stream-tool/options: signature preserved",
        );
    }

    // ===== Retry on transient error mid-stream =====
    {
        const transport = new ScriptedStreamTransport([
            {
                chunks: [],
                error: new TransportError("server", { statusCode: 503 }),
            },
            { chunks: [], toolCalls: [makeToolCall("c1", "x", {})] },
        ]);
        const client = new LlmClient({
            model: "m",
            transport,
            maxRetries: 2,
            sleep: async () => { },
            random: () => 0.5,
        });
        const response = await client.generate({
            instructions: [],
            events: [],
            tools: [toolDefinition("x")],
            onTextDelta: () => { },
        });
        checkEqual(
            response.toolCalls.length,
            1,
            "stream-tool/retry: recovered tool call",
        );
    }

    // ===== Live streaming tool call (through the fallback chain) =====
    //
    // Uses `buildDefaultFallbackChain()` so a 429 / 503 / quota wall on
    // one model rotates to the next in the chain. Same code path used by
    // `main.ts` and the workflows.
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (apiKey === undefined || apiKey === "") {
        skip("stream-tool/live: no GEMINI_API_KEY");
        return;
    }

    const { buildDefaultFallbackChain } = await import(
        "../src/workflows/_shared.js"
    );
    let client: LlmClientProtocol;
    try {
        client = buildDefaultFallbackChain();
    } catch (error) {
        skip(
            `stream-tool/live: cannot construct fallback chain: ${(error as Error).message}`,
        );
        return;
    }

    const deltas: string[] = [];

    try {
        const response = await client.generate({
            instructions: ["Use the add tool to add 2 and 3."],
            events: [
                makeEvent([
                    messageContentItem({ role: "user", content: "What is 2 + 3?" }),
                ]),
            ],
            tools: [toolDefinition("add")],
            toolChoice: "required",
            onTextDelta: (delta) => deltas.push(delta),
        });

        if (response.errorMessage !== null) {
            reportRotation("stream-tool/live", response.errorMetadata);
            if (isTransientLlmError(response.errorMessage, response.errorMetadata)) {
                skip(`stream-tool/live: transient: ${response.errorMessage}`);
                return;
            }
            check(false, `stream-tool/live: error: ${response.errorMessage}`);
            return;
        }

        if (response.errorMetadata.fallbackUsed === true) {
            process.stderr.write(
                `[verify] stream-tool/live: rotation used — tried ${JSON.stringify(response.errorMetadata.fallbackTried)}; landed on ${String(response.errorMetadata.fallbackLandedOn)}\n`,
            );
        }

        check(
            response.toolCalls.length === 1,
            "stream-tool/live: exactly one tool call",
        );
        if (response.toolCalls[0] !== undefined) {
            check(
                typeof response.toolCalls[0].arguments === "object" &&
                response.toolCalls[0].arguments !== null,
                "stream-tool/live: arguments are a parsed object",
            );
        }
    } catch (error) {
        // Never let an `AssertionError` from `check()` masquerade as a skip.
        if (error instanceof Error && error.name === "AssertionError") throw error;
        skip(`stream-tool/live: exception: ${(error as Error).message}`);
    }
});

function reportRotation(
    label: string,
    metadata: {
        fallbackTried?: string[];
        fallbackExhausted?: boolean;
        fallbackUsed?: boolean;
    },
): void {
    const tried = metadata.fallbackTried;
    if (tried === undefined || tried.length <= 1) return;
    const suffix = metadata.fallbackExhausted === true ? " (chain exhausted)" : "";
    process.stderr.write(
        `[verify] ${label}: rotated through ${JSON.stringify(tried)}${suffix}\n`,
    );
}