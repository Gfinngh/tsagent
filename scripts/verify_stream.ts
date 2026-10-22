import { LlmClient, type LlmClientProtocol } from "../src/agent/llm.js";
import {
    makeEvent,
    messageContentItem,
} from "../src/agent/schemas.js";
import {
    ScriptedStreamTransport,
    ScriptedTransport,
    TransportError,
    isTransientLlmError,
    textResult,
} from "./_verify-llm.js";
import { check, checkEqual, runScript, skip } from "./_verify-common.js";

runScript(async () => {
    // ===== Three chunks accumulate in order =====
    {
        const chunks: string[] = [];
        const transport = new ScriptedStreamTransport([
            { chunks: ["Hello", ", ", "world!"] },
        ]);
        const client = new LlmClient({ model: "m", transport });
        const response = await client.generate({
            instructions: [],
            events: [],
            onTextDelta: (delta) => chunks.push(delta),
        });
        checkEqual(chunks, ["Hello", ", ", "world!"], "stream: chunks received in order");
        checkEqual(response.text, "Hello, world!", "stream: final text concatenated");
        checkEqual(response.errorMessage, null, "stream: no error");
        checkEqual(response.toolCalls.length, 0, "stream: no tool calls");
    }

    // ===== Empty chunks -> text null =====
    {
        const transport = new ScriptedStreamTransport([{ chunks: [] }]);
        const client = new LlmClient({ model: "m", transport });
        const response = await client.generate({
            instructions: [],
            events: [],
            onTextDelta: () => { },
        });
        checkEqual(response.text, null, "stream/empty: text is null");
    }

    // ===== Single chunk =====
    {
        const chunks: string[] = [];
        const transport = new ScriptedStreamTransport([{ chunks: ["hi"] }]);
        const client = new LlmClient({ model: "m", transport });
        const response = await client.generate({
            instructions: [],
            events: [],
            onTextDelta: (delta) => chunks.push(delta),
        });
        checkEqual(chunks, ["hi"], "stream/single: one chunk");
        checkEqual(response.text, "hi", "stream/single: text matches");
    }

    // ===== Non-streaming path unchanged =====
    {
        const transport = new ScriptedTransport([{ result: textResult("plain") }]);
        const client = new LlmClient({ model: "m", transport });
        const response = await client.generate({ instructions: [], events: [] });
        checkEqual(response.text, "plain", "stream/no-callback: non-streaming works");
    }

    // ===== Retry on transient stream error =====
    {
        const chunks: string[] = [];
        const transport = new ScriptedStreamTransport([
            {
                chunks: ["a"],
                error: new TransportError("boom", { statusCode: 500 }),
            },
            { chunks: ["b", "c"] },
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
            onTextDelta: (delta) => chunks.push(delta),
        });
        checkEqual(response.text, "bc", "stream/retry: second attempt succeeds");
        checkEqual(chunks, ["a", "b", "c"], "stream/retry: chunks from both attempts");
        checkEqual(response.errorMetadata.attempts, 2, "stream/retry: two attempts");
    }

    // ===== Terminal stream error =====
    {
        const transport = new ScriptedStreamTransport([
            { chunks: [], error: new TransportError("auth", { statusCode: 401 }) },
        ]);
        const client = new LlmClient({
            model: "m",
            transport,
            maxRetries: 3,
            sleep: async () => { },
        });
        const response = await client.generate({
            instructions: [],
            events: [],
            onTextDelta: () => { },
        });
        checkEqual(response.text, null, "stream/terminal: no text");
        check(response.errorMessage !== null, "stream/terminal: errorMessage present");
        checkEqual(
            response.errorMetadata.attempts,
            1,
            "stream/terminal: one attempt, no retries",
        );
    }

    // ===== Live streaming (through the fallback chain) =====
    //
    // Uses `buildDefaultFallbackChain()` rather than a single `LlmClient`
    // so a 429 / 503 / quota wall on one model rotates to the next in the
    // chain instead of terminating the test. This is the same code path
    // `main.ts` and the workflows use.
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (apiKey === undefined || apiKey === "") {
        skip("stream/live: no GEMINI_API_KEY");
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
            `stream/live: cannot construct fallback chain: ${(error as Error).message}`,
        );
        return;
    }

    const chunks: string[] = [];

    try {
        const response = await client.generate({
            instructions: [
                "Reply with exactly the single word 'pong' and nothing else. No punctuation.",
            ],
            events: [
                makeEvent([messageContentItem({ role: "user", content: "ping" })]),
            ],
            onTextDelta: (delta) => chunks.push(delta),
        });

        if (response.errorMessage !== null) {
            reportRotation("stream/live", response.errorMetadata);
            if (isTransientLlmError(response.errorMessage, response.errorMetadata)) {
                skip(`stream/live: transient: ${response.errorMessage}`);
                return;
            }
            check(false, `stream/live: error: ${response.errorMessage}`);
            return;
        }

        if (response.errorMetadata.fallbackUsed === true) {
            process.stderr.write(
                `[verify] stream/live: rotation used — tried ${JSON.stringify(response.errorMetadata.fallbackTried)}; landed on ${String(response.errorMetadata.fallbackLandedOn)}\n`,
            );
        }

        check(
            response.text !== null && response.text.length > 0,
            "stream/live: got non-empty text",
        );
        check(chunks.length > 0, "stream/live: at least one delta received");
        // If rotation occurred mid-stream, partial chunks from earlier
        // attempts are prepended to the successful attempt's chunks. Assert
        // suffix-containment rather than equality so the invariant holds
        // regardless of where the fallback happened.
        check(
            chunks.join("").endsWith(response.text ?? ""),
            "stream/live: final response is suffix of accumulated chunks",
        );
    } catch (error) {
        // Never let an `AssertionError` from `check()` masquerade as a skip.
        if (error instanceof Error && error.name === "AssertionError") throw error;
        skip(`stream/live: exception: ${(error as Error).message}`);
    }
});

/**
 * When a generate call fails, print which models were tried. This makes
 * rotation observable even when the whole chain is exhausted on quota.
 */
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