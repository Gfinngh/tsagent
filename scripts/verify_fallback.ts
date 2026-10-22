import {
    FallbackClient,
    defaultFallbackPolicy,
    stripProviderOptionsFromEvents,
    type FallbackPolicy,
} from "../src/agent/fallback.js";
import type {
    LlmClientProtocol,
    LlmRequest,
    LlmResponse,
} from "../src/agent/llm.js";
import {
    makeEvent,
    messageContentItem,
    toolCallContentItem,
    toolResultContentItem,
} from "../src/agent/schemas.js";
import {
    ScriptedClient,
    errorResponse,
    makeToolCall,
    textResponse,
} from "./_verify-agent.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(async () => {
    // ===== Empty chain throws =====
    {
        let threw = false;
        try {
            new FallbackClient({ entries: [] });
        } catch (error) {
            threw = (error as Error).message.includes("at least one entry");
        }
        check(threw, "empty-chain: throws on construction");
    }

    // ===== First client succeeds: passthrough =====
    {
        const primary = new ScriptedClient([textResponse("hello")]);
        const backup = new ScriptedClient([]);
        const client = new FallbackClient({
            entries: [
                { name: "primary", client: primary },
                { name: "backup", client: backup },
            ],
        });
        const response = await client.generate({ instructions: [], events: [] });
        checkEqual(response.text, "hello", "first-success: text");
        checkEqual(response.errorMessage, null, "first-success: no error");
        checkEqual(response.errorMetadata.fallbackUsed, false, "first-success: not used");
        checkEqual(response.errorMetadata.fallbackLandedOn, "primary", "first-success: landedOn");
        checkEqual(response.errorMetadata.fallbackTried, ["primary"], "first-success: tried");
        checkEqual(response.errorMetadata.fallbackChainLength, 2, "first-success: chain length");
        checkEqual(primary.calls.length, 1, "first-success: primary called once");
        checkEqual(backup.calls.length, 0, "first-success: backup not called");
    }

    // ===== Primary fails with quota, backup succeeds =====
    {
        const primary = new ScriptedClient([
            errorResponse("quota exceeded", { errorType: "quota", quotaExhausted: true }),
        ]);
        const backup = new ScriptedClient([textResponse("from backup")]);
        const client = new FallbackClient({
            entries: [
                { name: "primary", client: primary },
                { name: "backup", client: backup },
            ],
        });
        const response = await client.generate({ instructions: [], events: [] });
        checkEqual(response.text, "from backup", "quota-fallback: text from backup");
        checkEqual(response.errorMessage, null, "quota-fallback: no error");
        checkEqual(response.errorMetadata.fallbackUsed, true, "quota-fallback: used");
        checkEqual(response.errorMetadata.fallbackFrom, "primary", "quota-fallback: from");
        checkEqual(response.errorMetadata.fallbackLandedOn, "backup", "quota-fallback: landedOn");
        checkEqual(response.errorMetadata.fallbackTried, ["primary", "backup"], "quota-fallback: tried");
        checkEqual(response.errorMetadata.fallbackChainLength, 2, "quota-fallback: chain length");
    }

    // ===== Primary fails with auth (terminal) =====
    {
        const primary = new ScriptedClient([
            errorResponse("unauthorized", { errorType: "auth", statusCode: 401 }),
        ]);
        const backup = new ScriptedClient([textResponse("should not be called")]);
        const client = new FallbackClient({
            entries: [
                { name: "primary", client: primary },
                { name: "backup", client: backup },
            ],
        });
        const response = await client.generate({ instructions: [], events: [] });
        check(response.errorMessage !== null, "auth-terminal: error present");
        checkEqual(response.errorMetadata.fallbackUsed, false, "auth-terminal: not used");
        checkEqual(
            response.errorMetadata.fallbackSkippedByPolicy,
            true,
            "auth-terminal: skipped by policy",
        );
        checkEqual(response.errorMetadata.fallbackTried, ["primary"], "auth-terminal: tried");
        checkEqual(backup.calls.length, 0, "auth-terminal: backup not called");
    }

    // ===== All clients fail: exhausted =====
    {
        const primary = new ScriptedClient([
            errorResponse("server error", { errorType: "server", statusCode: 500 }),
        ]);
        const backup = new ScriptedClient([
            errorResponse("server error", { errorType: "server", statusCode: 502 }),
        ]);
        const client = new FallbackClient({
            entries: [
                { name: "primary", client: primary },
                { name: "backup", client: backup },
            ],
        });
        const response = await client.generate({ instructions: [], events: [] });
        check(response.errorMessage !== null, "exhausted: error present");
        checkEqual(response.errorMetadata.fallbackExhausted, true, "exhausted: flag");
        checkEqual(response.errorMetadata.fallbackUsed, true, "exhausted: used");
        checkEqual(response.errorMetadata.fallbackTried, ["primary", "backup"], "exhausted: tried");
    }

    // ===== Three-entry chain: lands on third =====
    {
        const a = new ScriptedClient([errorResponse("quota", { errorType: "quota" })]);
        const b = new ScriptedClient([
            errorResponse("rate", { errorType: "rate_limit", statusCode: 429 }),
        ]);
        const c = new ScriptedClient([textResponse("from c")]);
        const client = new FallbackClient({
            entries: [
                { name: "a", client: a },
                { name: "b", client: b },
                { name: "c", client: c },
            ],
        });
        const response = await client.generate({ instructions: [], events: [] });
        checkEqual(response.text, "from c", "three-chain: text from c");
        checkEqual(response.errorMetadata.fallbackTried, ["a", "b", "c"], "three-chain: tried");
        checkEqual(response.errorMetadata.fallbackFrom, "b", "three-chain: lastFrom");
        checkEqual(response.errorMetadata.fallbackLandedOn, "c", "three-chain: landedOn");
    }

    // ===== Cancelled error from client (non-fallback path) =====
    {
        const cancelled: LlmResponse = {
            text: null,
            toolCalls: [],
            usage: null,
            providerOptions: {},
            errorMessage: "cancelled",
            errorMetadata: { errorType: "cancelled" },
        };
        const primary = new ScriptedClient([cancelled]);
        const backup = new ScriptedClient([textResponse("backup")]);
        const client = new FallbackClient({
            entries: [
                { name: "primary", client: primary },
                { name: "backup", client: backup },
            ],
        });
        const response = await client.generate({ instructions: [], events: [] });
        check(response.errorMessage !== null, "cancelled-response: error returned");
        checkEqual(
            response.errorMetadata.fallbackSkippedByPolicy,
            true,
            "cancelled-response: skipped by policy",
        );
        checkEqual(backup.calls.length, 0, "cancelled-response: backup not called");
    }

    // ===== Custom policy: everything falls back =====
    {
        const alwaysFallback: FallbackPolicy = { decide: () => "fallback" };
        const primary = new ScriptedClient([
            errorResponse("auth", { errorType: "auth", statusCode: 401 }),
        ]);
        const backup = new ScriptedClient([textResponse("ok")]);
        const client = new FallbackClient({
            entries: [
                { name: "primary", client: primary },
                { name: "backup", client: backup },
            ],
            policy: alwaysFallback,
        });
        const response = await client.generate({ instructions: [], events: [] });
        checkEqual(response.text, "ok", "custom-policy: uses backup");
        checkEqual(response.errorMetadata.fallbackUsed, true, "custom-policy: used");
    }

    // ===== Custom policy: never falls back =====
    {
        const neverFallback: FallbackPolicy = { decide: () => "terminal" };
        const primary = new ScriptedClient([
            errorResponse("quota", { errorType: "quota" }),
        ]);
        const backup = new ScriptedClient([textResponse("should not reach")]);
        const client = new FallbackClient({
            entries: [
                { name: "primary", client: primary },
                { name: "backup", client: backup },
            ],
            policy: neverFallback,
        });
        const response = await client.generate({ instructions: [], events: [] });
        check(response.errorMessage !== null, "custom-no-fallback: error returned");
        checkEqual(backup.calls.length, 0, "custom-no-fallback: backup not called");
    }

    // ===== defaultFallbackPolicy: direct decisions =====
    {
        const policy = defaultFallbackPolicy();
        const cases: Array<[string, "fallback" | "terminal"]> = [
            ["quota", "fallback"],
            ["rate_limit", "fallback"],
            ["server", "fallback"],
            ["timeout", "fallback"],
            ["auth", "terminal"],
            ["bad_request", "terminal"],
            ["not_found", "terminal"],
            ["context_window", "terminal"],
            ["cancelled", "terminal"],
            ["unknown", "terminal"],
            ["network", "terminal"],
        ];
        for (const [kind, expected] of cases) {
            const response: LlmResponse = {
                text: null,
                toolCalls: [],
                usage: null,
                providerOptions: {},
                errorMessage: kind,
                errorMetadata: { errorType: kind },
            };
            checkEqual(
                policy.decide(response),
                expected,
                `default-policy: ${kind} -> ${expected}`,
            );
        }
    }

    // ===== stripProviderOptionsFromEvents =====
    {
        const events = [
            makeEvent([messageContentItem({ role: "user", content: "go" })]),
            makeEvent([
                messageContentItem({ role: "assistant", content: null }),
                toolCallContentItem({
                    id: "call_1__thought__sig_xyz",
                    name: "add",
                    arguments: { a: 1, b: 2 },
                    providerOptions: { thought_signature: "sig_xyz" },
                }),
            ]),
            makeEvent([
                toolResultContentItem({
                    toolCallId: "call_1__thought__sig_xyz",
                    name: "add",
                    content: [3],
                    status: "success",
                }),
            ]),
            makeEvent([
                messageContentItem({
                    role: "assistant",
                    content: "done",
                    providerOptions: { thought_signature: "msg_sig" },
                }),
            ]),
        ];

        const stripped = stripProviderOptionsFromEvents(events);

        // Tool call id stripped.
        const strippedTc = stripped[1]?.content.find((c) => c.type === "tool_call");
        if (strippedTc?.type === "tool_call") {
            checkEqual(strippedTc.toolCall.id, "call_1", "strip: tool call id");
            checkEqual(strippedTc.toolCall.providerOptions, null, "strip: tool call providerOptions");
        }

        // Tool result toolCallId stripped.
        const strippedTr = stripped[2]?.content.find((c) => c.type === "tool_result");
        if (strippedTr?.type === "tool_result") {
            checkEqual(strippedTr.toolResult.toolCallId, "call_1", "strip: tool result toolCallId");
        }

        // Message providerOptions cleared.
        const strippedMsg = stripped[3]?.content.find((c) => c.type === "message");
        if (strippedMsg?.type === "message") {
            checkEqual(
                strippedMsg.message.providerOptions,
                {},
                "strip: message providerOptions cleared",
            );
        }

        // Original events unchanged.
        const origTc = events[1]?.content.find((c) => c.type === "tool_call");
        if (origTc?.type === "tool_call") {
            checkEqual(
                origTc.toolCall.id,
                "call_1__thought__sig_xyz",
                "strip: original event unchanged",
            );
        }
    }

    // ===== stripOnSwitch: only second client sees stripped events =====
    {
        const seenEvents: AgentEvent[][] = [];
        const recorder = (
            responses: LlmResponse[],
        ): LlmClientProtocol => {
            const inner = new ScriptedClient(responses);
            return {
                async generate(request: LlmRequest): Promise<LlmResponse> {
                    seenEvents.push(request.events);
                    return inner.generate(request);
                },
            };
        };

        const client = new FallbackClient({
            entries: [
                { name: "primary", client: recorder([errorResponse("q", { errorType: "quota" })]) },
                { name: "backup", client: recorder([textResponse("ok")]) },
            ],
            stripProviderOptionsOnSwitch: true,
        });

        const events = [
            makeEvent([
                toolCallContentItem({
                    id: "c1__thought__sig",
                    name: "x",
                    arguments: {},
                    providerOptions: { thought_signature: "sig" },
                }),
            ]),
        ];
        await client.generate({ instructions: [], events });

        checkEqual(seenEvents.length, 2, "stripOnSwitch: two calls");
        const first = seenEvents[0]?.[0]?.content[0];
        const second = seenEvents[1]?.[0]?.content[0];
        if (first?.type === "tool_call" && second?.type === "tool_call") {
            checkEqual(first.toolCall.id, "c1__thought__sig", "stripOnSwitch: primary original");
            checkEqual(second.toolCall.id, "c1", "stripOnSwitch: backup stripped");
            checkEqual(
                second.toolCall.providerOptions,
                null,
                "stripOnSwitch: backup providerOptions null",
            );
        }
    }

    // ===== Chain timeout: slow primary, no fallback consumed =====
    {
        const slowClient: LlmClientProtocol = {
            generate(request: LlmRequest): Promise<LlmResponse> {
                return new Promise((_resolve, reject) => {
                    const signal = request.signal;
                    if (signal !== undefined) {
                        if (signal.aborted) {
                            const err = new Error("aborted");
                            err.name = "AbortError";
                            reject(err);
                            return;
                        }
                        signal.addEventListener(
                            "abort",
                            () => {
                                const err = new Error("aborted");
                                err.name = "AbortError";
                                reject(err);
                            },
                            { once: true },
                        );
                    }
                });
            },
        };
        const backup = new ScriptedClient([]);
        const client = new FallbackClient({
            entries: [
                { name: "slow", client: slowClient },
                { name: "backup", client: backup },
            ],
            chainTimeoutMs: 80,
        });
        const response = await client.generate({ instructions: [], events: [] });
        check(response.errorMessage !== null, "chain-timeout: error present");
        check(
            (response.errorMessage ?? "").includes("timed out"),
            "chain-timeout: message mentions timed out",
        );
        checkEqual(response.errorMetadata.fallbackAborted, true, "chain-timeout: aborted");
        checkEqual(response.errorMetadata.retryReason, "chainTimeout", "chain-timeout: retryReason");
        checkEqual(response.errorMetadata.fallbackTried, ["slow"], "chain-timeout: tried");
        checkEqual(backup.calls.length, 0, "chain-timeout: backup not called");
    }

    // ===== Outer cancellation propagates as an exception =====
    {
        const slowClient: LlmClientProtocol = {
            generate(request: LlmRequest): Promise<LlmResponse> {
                return new Promise((_resolve, reject) => {
                    const signal = request.signal;
                    if (signal !== undefined) {
                        signal.addEventListener(
                            "abort",
                            () => {
                                const err = new Error("aborted");
                                err.name = "AbortError";
                                reject(err);
                            },
                            { once: true },
                        );
                    }
                });
            },
        };
        const client = new FallbackClient({
            entries: [{ name: "slow", client: slowClient }],
        });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 40);
        let threw = false;
        try {
            await client.generate({
                instructions: [],
                events: [],
                signal: controller.signal,
            });
        } catch (error) {
            threw = error instanceof Error && error.name === "AbortError";
        }
        check(threw, "cancel: propagates AbortError");
    }

    // ===== Same request forwarded to each client =====
    {
        const seenRequests: LlmRequest[] = [];
        const recorder = (
            responses: LlmResponse[],
        ): LlmClientProtocol => {
            const inner = new ScriptedClient(responses);
            return {
                async generate(request: LlmRequest): Promise<LlmResponse> {
                    seenRequests.push(request);
                    return inner.generate(request);
                },
            };
        };
        const primary = recorder([errorResponse("q", { errorType: "quota" })]);
        const backup = recorder([textResponse("ok")]);
        const client = new FallbackClient({
            entries: [
                { name: "primary", client: primary },
                { name: "backup", client: backup },
            ],
        });
        const userEvents = [makeEvent([messageContentItem({ role: "user", content: "hi" })])];
        await client.generate({
            instructions: ["sys"],
            events: userEvents,
            toolChoice: "auto",
            mode: "chat",
        });
        checkEqual(seenRequests.length, 2, "same-request: two calls");
        const r1 = seenRequests[0];
        const r2 = seenRequests[1];
        checkEqual(r1?.instructions, ["sys"], "same-request: primary instructions");
        checkEqual(r2?.instructions, ["sys"], "same-request: backup instructions");
        checkEqual(r1?.toolChoice, "auto", "same-request: primary toolChoice");
        checkEqual(r2?.toolChoice, "auto", "same-request: backup toolChoice");
        checkEqual(r1?.mode, "chat", "same-request: primary mode");
        checkEqual(r2?.mode, "chat", "same-request: backup mode");
    }
});

// Local type import for readability.
import type { AgentEvent } from "../src/agent/schemas.js";