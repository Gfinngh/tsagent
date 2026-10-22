/**
 * 09 — Fallback chain
 *
 * `FallbackClient` chains multiple LLM clients together. When one fails
 * in a retryable way (quota, rate limit, timeout, server error), the
 * chain advances to the next entry. When one succeeds, its response is
 * returned with metadata describing the journey.
 *
 * This demo uses a scripted "fake quota wall" as the primary client so
 * the rotation is deterministic and visible on every run — the backup
 * is a real Gemini call. In production, the chain is built by
 * `buildDefaultFallbackChain()` (see src/agent/runtime.ts), which reads
 * the model order from TSAGENT_MODEL_ORDER.
 *
 *   npx tsx examples/09-fallback.ts
 */

import { FallbackClient } from "../src/agent/fallback.js";
import {
    LlmClient,
    type LlmClientProtocol,
    type LlmRequest,
    type LlmResponse,
} from "../src/agent/llm.js";
import { getModelChain, resolveModel } from "../src/agent/models.js";
import {
    makeEvent,
    messageContentItem,
} from "../src/agent/schemas.js";
import { GoogleTransport } from "../src/agent/transport/google.js";
import { loadEnv } from "./_common.js";

loadEnv();

/**
 * A minimal stand-in that always reports a quota wall. Real quota
 * failures come from the provider; this makes the demo repeatable.
 */
class SimulatedQuotaClient implements LlmClientProtocol {
    async generate(_request: LlmRequest): Promise<LlmResponse> {
        return {
            text: null,
            toolCalls: [],
            usage: null,
            providerOptions: {},
            errorMessage: "simulated: free-tier quota exhausted",
            errorMetadata: {
                errorType: "quota",
                quotaExhausted: true,
                statusCode: 429,
            },
        };
    }
}

async function main(): Promise<void> {
    // Real backup — the weakest model in the configured chain.
    const backupModel = resolveModel(getModelChain()[0]!);
    const backupTransport = new GoogleTransport(backupModel);
    const backupClient = new LlmClient({
        model: backupModel,
        transport: backupTransport,
        maxRetries: 1,
    });

    const chain = new FallbackClient({
        entries: [
            { name: "simulated-quota-primary", client: new SimulatedQuotaClient() },
            { name: backupModel, client: backupClient },
        ],
    });

    console.log(`chain: simulated-quota-primary → ${backupModel}`);
    console.log('→ Say "fallback worked" and nothing else.\n');

    const response = await chain.generate({
        instructions: ['Say "fallback worked" and nothing else.'],
        events: [
            makeEvent([messageContentItem({ role: "user", content: "Go." })]),
        ],
    });

    console.log("--- response ---");
    if (response.errorMessage !== null) {
        console.log(`error: ${response.errorMessage}`);
    } else {
        console.log(`text: ${response.text}`);
    }

    console.log("\n--- fallback metadata ---");
    const meta = response.errorMetadata;
    console.log(`  fallbackUsed:        ${meta.fallbackUsed ?? false}`);
    console.log(`  fallbackFrom:        ${meta.fallbackFrom ?? "(none)"}`);
    console.log(`  fallbackLandedOn:    ${meta.fallbackLandedOn ?? "(none)"}`);
    console.log(`  fallbackChainLength: ${meta.fallbackChainLength ?? "?"}`);
    console.log(`  fallbackTried:       ${JSON.stringify(meta.fallbackTried ?? [])}`);

    console.log(
        "\nIn production, the CLI and every workflow use buildDefaultFallbackChain(),",
    );
    console.log(
        "which builds the same structure over all configured models.",
    );
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});