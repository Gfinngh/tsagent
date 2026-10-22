import { LlmClient, TransportError, classifyError } from "../src/agent/llm.js";
import { ScriptedTransport } from "./_verify-llm.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(async () => {
    // ===== QUOTA_EXCEEDED terminal =====
    const quotaTransport = new ScriptedTransport([
        {
            error: new TransportError("quota exceeded", {
                statusCode: 429,
                providerCode: "QUOTA_EXCEEDED",
            }),
        },
    ]);
    const quotaClient = new LlmClient({
        model: "m",
        transport: quotaTransport,
        maxRetries: 5,
        sleep: async () => { },
    });
    const quotaResp = await quotaClient.generate({ instructions: [], events: [] });
    checkEqual(quotaResp.text, null, "quota: no text");
    checkEqual(quotaResp.errorMetadata.quotaExhausted, true, "quota: exhausted flag");
    checkEqual(quotaResp.errorMetadata.retryable, false, "quota: not retryable");
    checkEqual(quotaTransport.calls.length, 1, "quota: transport called once");

    // ===== insufficient_quota terminal =====
    const insufficientTransport = new ScriptedTransport([
        {
            error: new TransportError("insufficient_quota", {
                statusCode: 429,
                providerCode: "insufficient_quota",
            }),
        },
    ]);
    const insufficientClient = new LlmClient({
        model: "m",
        transport: insufficientTransport,
        maxRetries: 3,
        sleep: async () => { },
    });
    const insResp = await insufficientClient.generate({ instructions: [], events: [] });
    checkEqual(insResp.errorMetadata.quotaExhausted, true, "insufficient: exhausted");
    checkEqual(insResp.errorMetadata.retryable, false, "insufficient: not retryable");

    // ===== classifyError direct: quota vs rate =====
    const quotaClassified = classifyError(
        new TransportError("q", { providerCode: "QUOTA_EXCEEDED" }),
    );
    checkEqual(quotaClassified.kind, "quota", "classify: QUOTA_EXCEEDED -> quota");
    checkEqual(quotaClassified.quotaExhausted, true, "classify: quotaExhausted true");

    const rateClassified = classifyError(
        new TransportError("rate", { statusCode: 429 }),
    );
    checkEqual(rateClassified.kind, "rate_limit", "classify: plain 429 -> rate_limit");
    checkEqual(rateClassified.quotaExhausted, false, "classify: plain 429 not exhausted");
});