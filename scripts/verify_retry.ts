import {
    LlmClient,
    TransportError,
    classifyError,
    computeBackoff,
} from "../src/agent/llm.js";
import { ScriptedTransport, textResult } from "./_verify-llm.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(async () => {
    // ===== classifyError: terminal cases =====
    const auth = classifyError(new TransportError("unauthorized", { statusCode: 401 }));
    checkEqual(auth.kind, "auth", "classify: 401 is auth");
    checkEqual(auth.retryable, false, "classify: 401 not retryable");

    const notFound = classifyError(new TransportError("missing", { statusCode: 404 }));
    checkEqual(notFound.kind, "not_found", "classify: 404 is not_found");

    const badReq = classifyError(new TransportError("bad", { statusCode: 400 }));
    checkEqual(badReq.kind, "bad_request", "classify: 400 is bad_request");

    const badReq422 = classifyError(new TransportError("bad", { statusCode: 422 }));
    checkEqual(badReq422.kind, "bad_request", "classify: 422 is bad_request");

    // ===== classifyError: retryable =====
    const rate = classifyError(new TransportError("rate limited", { statusCode: 429 }));
    checkEqual(rate.kind, "rate_limit", "classify: 429 is rate_limit");
    checkEqual(rate.retryable, true, "classify: 429 retryable");
    checkEqual(rate.rateLimited, true, "classify: 429 rateLimited");

    const server = classifyError(new TransportError("boom", { statusCode: 500 }));
    checkEqual(server.kind, "server", "classify: 500 is server");
    checkEqual(server.retryable, true, "classify: 500 retryable");

    const server503 = classifyError(new TransportError("boom", { statusCode: 503 }));
    checkEqual(server503.kind, "server", "classify: 503 is server");

    const timeout = classifyError(new TransportError("timeout", { statusCode: 408 }));
    checkEqual(timeout.kind, "timeout", "classify: 408 is timeout");
    checkEqual(timeout.retryable, true, "classify: 408 retryable");

    // ===== classifyError: 403 + quota reclassified as rate_limit =====
    const forbiddenQuota = classifyError(
        new TransportError("resource_exhausted: quota exceeded", { statusCode: 403 }),
    );
    checkEqual(forbiddenQuota.kind, "rate_limit", "classify: 403+quota is rate_limit");
    checkEqual(forbiddenQuota.retryable, true, "classify: 403+quota retryable");
    checkEqual(forbiddenQuota.rateLimited, true, "classify: 403+quota rateLimited");

    // ===== classifyError: RESOURCE_EXHAUSTED with short retry =====
    const shortQuota = classifyError(
        new TransportError("quota", {
            statusCode: 429,
            providerStatus: "RESOURCE_EXHAUSTED",
            retryAfterMs: 5_000,
        }),
    );
    checkEqual(shortQuota.kind, "rate_limit", "classify: RE + short retry is rate_limit");
    checkEqual(shortQuota.retryable, true, "classify: RE + short retry retryable");
    checkEqual(shortQuota.quotaExhausted, false, "classify: RE + short retry not exhausted");

    // ===== classifyError: RESOURCE_EXHAUSTED with long retry =====
    const longQuota = classifyError(
        new TransportError("quota", {
            statusCode: 429,
            providerStatus: "RESOURCE_EXHAUSTED",
            retryAfterMs: 120_000,
        }),
    );
    checkEqual(longQuota.kind, "quota", "classify: RE + long retry is quota");
    checkEqual(longQuota.retryable, false, "classify: RE + long retry not retryable");
    checkEqual(longQuota.quotaExhausted, true, "classify: RE + long retry exhausted");

    // ===== classifyError: terminal provider codes =====
    const insufficient = classifyError(
        new TransportError("insufficient", { providerCode: "insufficient_quota" }),
    );
    checkEqual(insufficient.kind, "quota", "classify: insufficient_quota is quota");
    checkEqual(insufficient.retryable, false, "classify: insufficient_quota not retryable");

    const apiKeyInvalid = classifyError(
        new TransportError("bad key", { providerCode: "API_KEY_INVALID" }),
    );
    checkEqual(apiKeyInvalid.kind, "quota", "classify: API_KEY_INVALID is quota");

    // ===== classifyError: context-window hints =====
    const ctx = classifyError(
        new TransportError("This model's maximum context length is 4096 tokens", {
            statusCode: 400,
        }),
    );
    checkEqual(ctx.kind, "context_window", "classify: context-window hint");
    checkEqual(ctx.retryable, false, "classify: context-window not retryable");

    // ===== classifyError: unknown exceptions default to terminal =====
    const unknown = classifyError(new Error("mystery"));
    checkEqual(unknown.kind, "unknown", "classify: unknown error is 'unknown'");
    checkEqual(unknown.retryable, false, "classify: unknown error not retryable");

    // ===== classifyError: AbortError is cancelled =====
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const cancelled = classifyError(abortErr);
    checkEqual(cancelled.kind, "cancelled", "classify: AbortError is cancelled");
    checkEqual(cancelled.retryable, false, "classify: AbortError not retryable");

    // ===== computeBackoff =====
    const noJitter = () => 0.5;
    checkEqual(computeBackoff(1, noJitter), 500, "backoff: attempt 1 = 500");
    checkEqual(computeBackoff(2, noJitter), 1000, "backoff: attempt 2 = 1000");
    checkEqual(computeBackoff(3, noJitter), 2000, "backoff: attempt 3 = 2000");
    checkEqual(computeBackoff(4, noJitter), 4000, "backoff: attempt 4 = 4000");
    checkEqual(computeBackoff(5, noJitter), 8000, "backoff: attempt 5 = 8000");
    checkEqual(computeBackoff(6, noJitter), 8000, "backoff: attempt 6 capped at 8000");

    // Jitter bounds: -25% to +25% of base
    const base1 = 500;
    for (let i = 0; i < 20; i += 1) {
        const value = computeBackoff(1);
        check(
            value >= Math.round(base1 * 0.75) && value <= Math.round(base1 * 1.25),
            `backoff: attempt 1 with jitter in [375, 625] (got ${value})`,
        );
    }

    // ===== Retry loop: success on third attempt =====
    const retryTransport = new ScriptedTransport([
        { error: new TransportError("rate", { statusCode: 429 }) },
        { error: new TransportError("boom", { statusCode: 500 }) },
        { result: textResult("finally") },
    ]);
    const retryClient = new LlmClient({
        model: "m",
        transport: retryTransport,
        maxRetries: 2,
        sleep: async () => { },
        random: () => 0.5,
    });
    const retryResp = await retryClient.generate({ instructions: [], events: [] });
    checkEqual(retryResp.text, "finally", "retry: success on third attempt");
    checkEqual(retryTransport.calls.length, 3, "retry: three transport calls");
    checkEqual(retryResp.errorMetadata.attempts, 3, "retry: attempts = 3");

    // ===== Retry loop: terminal error returns immediately =====
    const terminalTransport = new ScriptedTransport([
        { error: new TransportError("auth", { statusCode: 401 }) },
        { result: textResult("should not be reached") },
    ]);
    const terminalClient = new LlmClient({
        model: "m",
        transport: terminalTransport,
        maxRetries: 2,
        sleep: async () => { },
    });
    const terminalResp = await terminalClient.generate({ instructions: [], events: [] });
    checkEqual(terminalResp.text, null, "retry: terminal returns null text");
    check(terminalResp.errorMessage !== null, "retry: terminal has errorMessage");
    checkEqual(terminalTransport.calls.length, 1, "retry: terminal calls transport once");
    checkEqual(
        terminalResp.errorMetadata.retryable,
        false,
        "retry: terminal metadata retryable false",
    );

    // ===== Retry loop: exhausted retries =====
    const exhaustTransport = new ScriptedTransport([
        { error: new TransportError("boom", { statusCode: 500 }) },
        { error: new TransportError("boom", { statusCode: 500 }) },
        { error: new TransportError("boom", { statusCode: 500 }) },
    ]);
    const exhaustClient = new LlmClient({
        model: "m",
        transport: exhaustTransport,
        maxRetries: 2,
        sleep: async () => { },
        random: () => 0.5,
    });
    const exhaustResp = await exhaustClient.generate({ instructions: [], events: [] });
    checkEqual(exhaustTransport.calls.length, 3, "retry: exhausted uses maxRetries+1 attempts");
    checkEqual(
        exhaustResp.errorMetadata.retryExhausted,
        true,
        "retry: exhausted metadata flag",
    );

    // ===== Deadline: fail fast if next backoff exceeds timeoutMs =====
    const deadlineTransport = new ScriptedTransport([
        { error: new TransportError("boom", { statusCode: 500 }) },
        { error: new TransportError("boom", { statusCode: 500 }) },
    ]);
    let slept = false;
    const deadlineClient = new LlmClient({
        model: "m",
        transport: deadlineTransport,
        maxRetries: 5,
        timeoutMs: 100,
        sleep: async (ms) => {
            slept = true;
            await new Promise((resolve) => setTimeout(resolve, ms));
        },
        random: () => 0.5,
    });
    const deadlineResp = await deadlineClient.generate({ instructions: [], events: [] });
    checkEqual(
        deadlineResp.errorMetadata.retryReason,
        "timeoutBeforeRetry",
        "deadline: retryReason is timeoutBeforeRetry",
    );
    checkEqual(
        deadlineTransport.calls.length,
        1,
        "deadline: only one transport call before fail-fast",
    );
    checkEqual(slept, false, "deadline: did not sleep past the timeout");

    // ===== maxRetries = 0 → single attempt =====
    const singleTransport = new ScriptedTransport([
        { error: new TransportError("boom", { statusCode: 500 }) },
    ]);
    const singleClient = new LlmClient({
        model: "m",
        transport: singleTransport,
        maxRetries: 0,
        sleep: async () => { },
    });
    const singleResp = await singleClient.generate({ instructions: [], events: [] });
    checkEqual(singleTransport.calls.length, 1, "maxRetries=0: single call");
    checkEqual(singleResp.text, null, "maxRetries=0: returns error");
    checkEqual(singleResp.errorMetadata.retryExhausted, true, "maxRetries=0: retryExhausted");
});