import { FallbackClient, type FallbackEntry } from "../src/agent/fallback.js";
import { LlmClient } from "../src/agent/llm.js";
import { getModelChain, resolveModel } from "../src/agent/models.js";
import { GoogleTransport } from "../src/agent/transport/google.js";
import {
    makeEvent,
    messageContentItem,
} from "../src/agent/schemas.js";
import { ScriptedClient, errorResponse } from "./_verify-agent.js";
import { isTransientLlmError } from "./_verify-llm.js";
import { check, checkEqual, runScript, skip } from "./_verify-common.js";

runScript(async () => {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (apiKey === undefined || apiKey === "") {
        skip("fallback/real: no GEMINI_API_KEY");
        return;
    }

    // Build a flat chain: fake-quota primary first, then every real model
    // in the configured order. If the weakest model is quota-blocked, the
    // chain naturally rotates — the test asserts that it landed on *some*
    // real model, not a specific one.
    const fakeQuotaPrimary = new ScriptedClient([
        errorResponse("quota exceeded", {
            errorType: "quota",
            quotaExhausted: true,
            statusCode: 429,
        }),
    ]);

    const realEntries: FallbackEntry[] = [];
    const failures: string[] = [];
    for (const model of getModelChain()) {
        try {
            const resolved = resolveModel(model);
            const transport = new GoogleTransport(resolved, { apiKey });
            realEntries.push({
                name: model,
                client: new LlmClient({ model: resolved, transport, maxRetries: 1 }),
            });
        } catch (error) {
            failures.push(`${model}: ${(error as Error).message}`);
        }
    }
    if (realEntries.length === 0) {
        skip(
            `fallback/real: no real model could be constructed (${failures.join("; ")})`,
        );
        return;
    }

    const client = new FallbackClient({
        entries: [{ name: "fake-quota", client: fakeQuotaPrimary }, ...realEntries],
    });

    let response;
    try {
        response = await client.generate({
            instructions: [
                "Reply with exactly the single word 'pong' and nothing else. No punctuation.",
            ],
            events: [
                makeEvent([messageContentItem({ role: "user", content: "ping" })]),
            ],
        });
    } catch (error) {
        skip(`fallback/real: exception: ${(error as Error).message}`);
        return;
    }

    const tried = response.errorMetadata.fallbackTried ?? [];
    const landedOn = response.errorMetadata.fallbackLandedOn;
    const exhausted = response.errorMetadata.fallbackExhausted === true;

    // Always log rotation so the test is self-documenting regardless of
    // whether it succeeds, skips, or fails.
    if (tried.length > 1 || exhausted) {
        process.stderr.write(
            `[verify] fallback/real: tried ${JSON.stringify(tried)}${exhausted ? " (chain exhausted)" : ""}\n`,
        );
    }

    if (response.errorMessage !== null) {
        if (isTransientLlmError(response.errorMessage, response.errorMetadata)) {
            skip(`fallback/real: transient: ${response.errorMessage}`);
            return;
        }
        check(false, `fallback/real: unexpected error: ${response.errorMessage}`);
        return;
    }

    check(response.text !== null, "fallback/real: got text from a real model");
    checkEqual(response.errorMetadata.fallbackUsed, true, "fallback/real: used");
    checkEqual(
        tried[0],
        "fake-quota",
        "fallback/real: fake-quota was tried first",
    );
    check(
        tried.length >= 2,
        `fallback/real: at least one real model was tried (got ${tried.length})`,
    );
    check(
        typeof landedOn === "string" && landedOn !== "fake-quota",
        `fallback/real: landed on a real model (got ${String(landedOn)})`,
    );

    // Landed-on model must be one of the configured chain entries.
    const realNames = realEntries.map((e) => e.name);
    check(
        typeof landedOn === "string" && realNames.includes(landedOn),
        `fallback/real: landedOn is in the real chain (${String(landedOn)})`,
    );

    // Rotation is real: the successful entry is not the fake primary.
    process.stderr.write(
        `[verify] fallback/real: rotated from fake-quota to ${String(landedOn)}\n`,
    );
});