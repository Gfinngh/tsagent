/**
 * 06 — Streaming
 *
 * Show incremental text delivery. The `LlmClient` supports an
 * `onTextDelta` callback; each chunk is fired as it arrives from the
 * provider, and the final full text is also available on the response.
 *
 * Note: this demo uses `LlmClient` directly (the transport-level
 * interface). The `Agent` layer currently requests non-streaming
 * responses; if you want streaming inside an agent loop, wire the same
 * `onTextDelta` into a custom `LlmClient` before handing it to
 * `new Agent()`.
 *
 *   npx tsx examples/06-streaming.ts
 */

import { LlmClient } from "../src/agent/llm.js";
import { getModelChain, resolveModel } from "../src/agent/models.js";
import {
    makeEvent,
    messageContentItem,
} from "../src/agent/schemas.js";
import { GoogleTransport } from "../src/agent/transport/google.js";
import { loadEnv } from "./_common.js";

loadEnv();

async function main(): Promise<void> {
    // Use the weakest model in the configured chain (test order default).
    const model = resolveModel(getModelChain()[0]!);
    const transport = new GoogleTransport(model);
    const client = new LlmClient({
        model,
        transport,
        maxRetries: 1,
    });

    console.log(`model: ${model}`);
    console.log("→ Write a haiku about the sea.\n");

    let chunkCount = 0;
    const response = await client.generate({
        instructions: ["Write a haiku about the sea. Three short lines."],
        events: [
            makeEvent([messageContentItem({ role: "user", content: "Go." })]),
        ],
        onTextDelta: (delta) => {
            chunkCount += 1;
            process.stdout.write(delta);
        },
    });

    process.stdout.write("\n");
    console.log(`\n(${chunkCount} delta(s) received)`);
    if (response.errorMessage !== null) {
        console.log(`error: ${response.errorMessage}`);
    }
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});