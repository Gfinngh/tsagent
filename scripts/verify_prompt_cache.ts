/**
 * Verification: incremental prompt cache.
 *
 * `PromptCache` must produce output structurally identical to
 * `buildMessages(instructions, events)` for every prefix of the events
 * sequence, and old snapshots must not be mutated by later extension.
 */

import {
    buildMessages,
    type ChatMessage,
} from "../src/agent/llm.js";
import { PromptCache } from "../src/agent/prompt-cache.js";
import {
    makeEvent,
    messageContentItem,
    toolCallContentItem,
    toolResultContentItem,
    type AgentEvent,
} from "../src/agent/schemas.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

function deepEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    if (a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i += 1) {
            if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
        if (!(k in bObj)) return false;
        if (!deepEqual(aObj[k], bObj[k])) return false;
    }
    return true;
}

function sameAsReference(
    cache: PromptCache,
    instructions: string[],
    events: AgentEvent[],
    label: string,
): ChatMessage[] {
    const actual = cache.build(events);
    const expected = buildMessages(instructions, events);
    check(
        deepEqual(actual, expected),
        `${label}: matches buildMessages`,
    );
    return actual;
}

runScript(() => {
    // =====================================================================
    // 1. Fresh cache with no events → system message only
    // =====================================================================
    {
        const instructions = ["you are helpful"];
        const cache = new PromptCache(instructions);
        const messages = sameAsReference(cache, instructions, [], "empty");
        checkEqual(messages.length, 1, "empty: one message (system)");
        checkEqual(messages[0]?.role, "system", "empty: system role");
    }

    // =====================================================================
    // 2. Fresh cache with no instructions, no events → []
    // =====================================================================
    {
        const instructions: string[] = [];
        const cache = new PromptCache(instructions);
        const messages = sameAsReference(cache, instructions, [], "no-instructions");
        checkEqual(messages.length, 0, "no-instructions: zero messages");
    }

    // =====================================================================
    // 3. Single user event
    // =====================================================================
    {
        const instructions = ["sys"];
        const cache = new PromptCache(instructions);
        const events = [makeEvent([messageContentItem({ role: "user", content: "hi" })])];
        const messages = sameAsReference(cache, instructions, events, "single-user");
        checkEqual(messages.length, 2, "single-user: system + user");
    }

    // =====================================================================
    // 4. Extend by one event
    // =====================================================================
    {
        const instructions = ["sys"];
        const cache = new PromptCache(instructions);
        const events: AgentEvent[] = [];
        events.push(makeEvent([messageContentItem({ role: "user", content: "hi" })]));
        sameAsReference(cache, instructions, [...events], "extend/1");

        events.push(
            makeEvent([messageContentItem({ role: "assistant", content: "hello" })]),
        );
        sameAsReference(cache, instructions, [...events], "extend/2");

        events.push(makeEvent([messageContentItem({ role: "user", content: "next" })]));
        sameAsReference(cache, instructions, [...events], "extend/3");
    }

    // =====================================================================
    // 5. Extend with assistant + tool_call in one event
    // =====================================================================
    {
        const instructions = ["sys"];
        const cache = new PromptCache(instructions);
        const events: AgentEvent[] = [];
        events.push(makeEvent([messageContentItem({ role: "user", content: "go" })]));
        sameAsReference(cache, instructions, [...events], "tool/1");

        events.push(
            makeEvent([
                messageContentItem({ role: "assistant", content: null }),
                toolCallContentItem({
                    id: "c1",
                    name: "add",
                    arguments: { a: 1, b: 2 },
                    providerOptions: null,
                }),
            ]),
        );
        sameAsReference(cache, instructions, [...events], "tool/2");
    }

    // =====================================================================
    // 6. Two tool_calls in one event → assistant has both
    // =====================================================================
    {
        const instructions = ["sys"];
        const cache = new PromptCache(instructions);
        const events: AgentEvent[] = [];
        events.push(makeEvent([messageContentItem({ role: "user", content: "go" })]));
        events.push(
            makeEvent([
                messageContentItem({ role: "assistant", content: null }),
                toolCallContentItem({ id: "c1", name: "a", arguments: {}, providerOptions: null }),
                toolCallContentItem({ id: "c2", name: "b", arguments: {}, providerOptions: null }),
            ]),
        );
        const messages = sameAsReference(cache, instructions, [...events], "multi-tool");
        const assistant = messages.find((m) => m.role === "assistant");
        if (assistant?.role !== "assistant") {
            check(false, "multi-tool: assistant present");
            return;
        }
        checkEqual(assistant.toolCalls?.length, 2, "multi-tool: two tool calls");
    }

    // =====================================================================
    // 7. Old snapshots are NOT mutated by later extension (KEY TEST)
    // =====================================================================
    //
    // This is the invariant that `appendToolCall`'s non-mutating design
    // guarantees. Without it, extending the cache in step 2 would mutate
    // the assistant message captured in step 1's snapshot — visible to
    // anyone who held on to the snapshot (e.g., a `captureRequest` hook
    // or a test assertion).
    {
        const instructions = ["sys"];
        const cache = new PromptCache(instructions);

        // Step 1: [user, assistant+tcA]
        const events1: AgentEvent[] = [];
        events1.push(makeEvent([messageContentItem({ role: "user", content: "go" })]));
        events1.push(
            makeEvent([
                messageContentItem({ role: "assistant", content: null }),
                toolCallContentItem({ id: "cA", name: "a", arguments: {}, providerOptions: null }),
            ]),
        );
        const snap1 = cache.build(events1);

        // Locate the assistant in snap1 and record its toolCalls length.
        const assistant1 = snap1.find((m) => m.role === "assistant");
        if (assistant1?.role !== "assistant") {
            check(false, "non-mutating: assistant present in snap1");
            return;
        }
        const snap1ToolCallsLength = assistant1.toolCalls?.length ?? 0;
        checkEqual(snap1ToolCallsLength, 1, "non-mutating: snap1 assistant has 1 tool call");

        // Step 2: extend with [tool_result_A, assistant+tcB]
        const events2 = [...events1];
        events2.push(
            makeEvent([
                toolResultContentItem({
                    toolCallId: "cA",
                    name: "a",
                    content: ["ok"],
                    status: "success",
                }),
            ]),
        );
        events2.push(
            makeEvent([
                messageContentItem({ role: "assistant", content: null }),
                toolCallContentItem({ id: "cB", name: "b", arguments: {}, providerOptions: null }),
            ]),
        );
        cache.build(events2);

        // The critical assertion: snap1's assistant is unchanged. If
        // `appendToolCall` had mutated it, it would now have 2 tool calls
        // (or a tool_result appended to something shared).
        const snap1After = snap1.find((m) => m.role === "assistant");
        if (snap1After?.role !== "assistant") {
            check(false, "non-mutating: assistant still present in snap1");
            return;
        }
        checkEqual(
            snap1After.toolCalls?.length,
            snap1ToolCallsLength,
            "non-mutating: snap1 assistant toolCalls count unchanged",
        );
        checkEqual(
            snap1.length,
            3,
            "non-mutating: snap1 length unchanged",
        );
    }

    // =====================================================================
    // 8. Idempotent: same events → same output
    // =====================================================================
    {
        const instructions = ["sys"];
        const cache = new PromptCache(instructions);
        const events = [
            makeEvent([messageContentItem({ role: "user", content: "hi" })]),
            makeEvent([messageContentItem({ role: "assistant", content: "hello" })]),
        ];
        const first = cache.build(events);
        const second = cache.build(events);
        check(deepEqual(first, second), "idempotent: same events → same output");
        check(first !== second, "idempotent: fresh array each call");
    }

    // =====================================================================
    // 9. Full round-trip with tool results
    // =====================================================================
    {
        const instructions = ["sys"];
        const cache = new PromptCache(instructions);
        const events: AgentEvent[] = [];
        events.push(makeEvent([messageContentItem({ role: "user", content: "compute" })]));
        sameAsReference(cache, instructions, [...events], "roundtrip/1");

        events.push(
            makeEvent([
                messageContentItem({ role: "assistant", content: null }),
                toolCallContentItem({ id: "c1", name: "calc", arguments: {}, providerOptions: null }),
            ]),
        );
        sameAsReference(cache, instructions, [...events], "roundtrip/2");

        events.push(
            makeEvent([
                toolResultContentItem({
                    toolCallId: "c1",
                    name: "calc",
                    content: [42],
                    status: "success",
                }),
            ]),
        );
        sameAsReference(cache, instructions, [...events], "roundtrip/3");

        events.push(
            makeEvent([messageContentItem({ role: "assistant", content: "the answer is 42" })]),
        );
        const messages = sameAsReference(cache, instructions, [...events], "roundtrip/4");
        checkEqual(messages.length, 5, "roundtrip/4: system + 4 messages");
    }

    // =====================================================================
    // 10. Events appended in multiple build calls vs single build call
    // =====================================================================
    {
        const instructions = ["sys"];
        const cacheIncremental = new PromptCache(instructions);
        const cacheFull = new PromptCache(instructions);
        const events: AgentEvent[] = [
            makeEvent([messageContentItem({ role: "user", content: "hi" })]),
            makeEvent([messageContentItem({ role: "assistant", content: "hello" })]),
            makeEvent([messageContentItem({ role: "user", content: "again" })]),
            makeEvent([messageContentItem({ role: "assistant", content: "still here" })]),
        ];

        // Incremental: build after each event.
        let incrementalFinal: ChatMessage[] = [];
        for (let i = 1; i <= events.length; i += 1) {
            incrementalFinal = cacheIncremental.build(events.slice(0, i));
        }

        // Full: build once with all events.
        const fullFinal = cacheFull.build(events);

        check(
            deepEqual(incrementalFinal, fullFinal),
            "incremental vs full: identical output",
        );
    }

    // =====================================================================
    // 11. Nested providerOptions preserved through incremental extension
    // =====================================================================
    {
        const instructions = ["sys"];
        const cache = new PromptCache(instructions);
        const events: AgentEvent[] = [
            makeEvent([messageContentItem({ role: "user", content: "hi" })]),
            makeEvent([
                messageContentItem({ role: "assistant", content: null }),
                toolCallContentItem({
                    id: "c1",
                    name: "add",
                    arguments: {},
                    providerOptions: { thought_signature: "sig_xyz" },
                }),
            ]),
        ];
        const messages = cache.build(events);
        const assistant = messages.find((m) => m.role === "assistant");
        if (assistant?.role !== "assistant") {
            check(false, "providerOptions: assistant present");
            return;
        }
        const tc = assistant.toolCalls?.[0];
        checkEqual(
            (tc?.providerOptions as Record<string, unknown> | null | undefined)
                ?.thought_signature,
            "sig_xyz",
            "providerOptions: signature preserved through cache",
        );
    }
});