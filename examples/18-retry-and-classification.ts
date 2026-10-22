/**
 * 18 — Error classification and retry
 *
 * `LlmClient` classifies every failure into one of a small set of
 * kinds, and the retry loop treats each kind differently:
 *
 *   retryable  → retry with exponential backoff and jitter
 *   terminal   → surface immediately
 *
 * This example first shows `classifyError` on a set of representative
 * failures, then drives a small retry demo through the real `LlmClient`
 * with a scripted transport that fails twice and then succeeds.
 *
 * Both halves run with no real API calls. No quota consumed.
 *
 *   npx tsx examples/18-retry-and-classification.ts
 */

import {
    LlmClient,
    TransportError,
    classifyError,
    computeBackoff,
    type LlmRequest,
    type LlmResponse,
    type Transport,
    type TransportResult,
} from "../src/agent/llm.js";
import { makeEvent, messageContentItem } from "../src/agent/schemas.js";
import { loadEnv, section } from "./_common.js";

loadEnv();

function report(label: string, error: unknown): void {
    const c = classifyError(error);
    const msg = error instanceof Error ? error.message : String(error);
    console.log(
        `  ${label.padEnd(32)} kind=${c.kind.padEnd(13)} retryable=${c.retryable}${c.retryAfterMs !== null ? ` retryAfterMs=${c.retryAfterMs}` : ""}`,
    );
    void msg;
}

async function main(): Promise<void> {
    section("1. classifyError — the taxonomy");
    console.log("");
    report("401 unauthorized", new TransportError("unauth", { statusCode: 401 }));
    report("403 forbidden", new TransportError("forbidden", { statusCode: 403 }));
    report(
        "403 + quota hint",
        new TransportError("quota exceeded", { statusCode: 403 }),
    );
    report("404 not found", new TransportError("missing", { statusCode: 404 }));
    report(
        "408 timeout",
        new TransportError("timeout", { statusCode: 408 }),
    );
    report(
        "429 rate limit (no retry hint)",
        new TransportError("rate", { statusCode: 429 }),
    );
    report(
        "429 + short retry",
        new TransportError("rate", {
            statusCode: 429,
            providerStatus: "RESOURCE_EXHAUSTED",
            retryAfterMs: 5_000,
        }),
    );
    report(
        "429 + long retry (quota wall)",
        new TransportError("quota", {
            statusCode: 429,
            providerStatus: "RESOURCE_EXHAUSTED",
            retryAfterMs: 3_600_000,
        }),
    );
    report(
        "500 server error",
        new TransportError("server", { statusCode: 500 }),
    );
    report(
        "400 bad request",
        new TransportError("bad", { statusCode: 400 }),
    );
    report(
        "context-window hint",
        new TransportError(
            "This model's maximum context length is 4096 tokens",
            { statusCode: 400 },
        ),
    );

    section("2. computeBackoff");
    console.log("");
    // jitter fixed at 0.5 for deterministic numbers
    const noJitter = () => 0.5;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        const delay = computeBackoff(attempt, noJitter);
        console.log(`  attempt ${attempt}: ${delay}ms`);
    }

    section("3. live retry loop");
    console.log("");

    // A transport that fails twice with a retryable error, then succeeds.
    let callCount = 0;
    const flakyTransport: Transport = {
        async call(_req: Parameters<Transport["call"]>[0]): Promise<TransportResult> {
            callCount += 1;
            if (callCount <= 2) {
                throw new TransportError("temporary server error", {
                    statusCode: 500,
                });
            }
            return {
                text: "success on attempt 3",
                toolCalls: [],
                usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
                providerOptions: {},
            };
        },
    };

    const client = new LlmClient({
        model: "demo",
        transport: flakyTransport,
        maxRetries: 3,
        sleep: async () => {
            // No actual waiting — the example runs instantly.
        },
    });

    const request: LlmRequest = {
        instructions: [],
        events: [
            makeEvent([messageContentItem({ role: "user", content: "go" })]),
        ],
    };
    const response: LlmResponse = await client.generate(request);
    console.log(`  transport calls made: ${callCount}`);
    console.log(`  final text:           ${response.text ?? "(none)"}`);
    console.log(
        `  final errorMessage:   ${response.errorMessage ?? "(none)"}`,
    );

    section("notes");
    console.log(
        "Retry attempts are bounded by maxRetries. Terminal errors (401, 404,",
    );
    console.log(
        "400, 422, quota walls) return immediately. The FallbackClient (see",
    );
    console.log(
        "examples/09-fallback.ts) sits one layer up and rotates to a different",
    );
    console.log("model on retryable failures.");
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});