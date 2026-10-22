/**
 * 24 — Prompt cache
 *
 * `buildMessages(instructions, events)` walks every event and
 * re-serializes every tool result. That cost adds up over many steps.
 * `PromptCache` keeps the built `ChatMessage[]` around and only
 * appends the delta on each call.
 *
 * Correctness invariant: `cache.build(events)` must be **structurally
 * identical** to `buildMessages(instructions, events)` for any prefix
 * of the events sequence, and old snapshots must not be mutated by a
 * later extension. This example demonstrates both.
 *
 * Pure local demo. No LLM.
 *
 *   npx tsx examples/24-prompt-cache.ts
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
import { section } from "./_common.js";

function summarize(messages: ChatMessage[]): string {
    return messages
        .map((m) => {
            if (m.role === "assistant" && m.toolCalls !== undefined) {
                return `assistant(${m.toolCalls.length} tool calls)`;
            }
            if (m.role === "tool") {
                return `tool(${m.content.slice(0, 20)}...)`;
            }
            return `${m.role}(${(m as { content: string }).content.slice(0, 20)}...)`;
        })
        .join(" → ");
}

async function main(): Promise<void> {
    const instructions = ["You are a helpful assistant."];

    // Build a sequence of events incrementally.
    const events: AgentEvent[] = [];
    events.push(makeEvent([messageContentItem({ role: "user", content: "compute 2 + 3" })]));
    events.push(
        makeEvent([
            messageContentItem({ role: "assistant", content: null }),
            toolCallContentItem({
                id: "c1",
                name: "add",
                arguments: { a: 2, b: 3 },
                providerOptions: null,
            }),
        ]),
    );
    events.push(
        makeEvent([
            toolResultContentItem({
                toolCallId: "c1",
                name: "add",
                content: [5],
                status: "success",
                errorKind: null,
            }),
        ]),
    );
    events.push(makeEvent([messageContentItem({ role: "assistant", content: "The answer is 5." })]));

    section("1. full build — the reference implementation");
    {
        const messages = buildMessages(instructions, events);
        console.log(`  ${messages.length} messages`);
        console.log(`  ${summarize(messages)}`);
    }

    section("2. incremental build — one event at a time");
    {
        const cache = new PromptCache(instructions);
        for (let i = 1; i <= events.length; i += 1) {
            const messages = cache.build(events.slice(0, i));
            console.log(`  after ${i} event(s): ${summarize(messages)}`);
        }
    }

    section("3. incremental vs full — structurally identical");
    {
        const cache = new PromptCache(instructions);
        for (let i = 1; i <= events.length; i += 1) {
            cache.build(events.slice(0, i));
        }
        const incrementalFinal = cache.build(events);
        const fullFinal = buildMessages(instructions, events);
        console.log(
            `  identical: ${JSON.stringify(incrementalFinal) === JSON.stringify(fullFinal)}`,
        );
    }

    section("4. old snapshots are not mutated by later extension");
    {
        const cache = new PromptCache(instructions);
        // Snapshot after the first two events.
        const earlySnapshot = cache.build(events.slice(0, 2));
        const earlyAssistant = earlySnapshot.find((m) => m.role === "assistant");
        const earlyToolCalls =
            earlyAssistant?.role === "assistant"
                ? (earlyAssistant.toolCalls?.length ?? 0)
                : 0;
        console.log(
            `  snapshot assistant toolCalls count (early): ${earlyToolCalls}`,
        );

        // Extend the cache with the remaining events.
        cache.build(events);

        // Re-check the snapshot.
        const stillEarly = earlySnapshot.find((m) => m.role === "assistant");
        const nowToolCalls =
            stillEarly?.role === "assistant"
                ? (stillEarly.toolCalls?.length ?? 0)
                : 0;
        console.log(
            `  snapshot assistant toolCalls count (still): ${nowToolCalls}`,
        );
        console.log(
            `  unchanged: ${earlyToolCalls === nowToolCalls && earlyToolCalls === 1}`,
        );
    }

    section("5. where this is used");
    console.log("Agent.run and Agent.resume build one PromptCache per loop");
    console.log("and pass `prebuiltMessages` to `LlmClient.generate` via the");
    console.log("`LlmRequest.prebuiltMessages` field, avoiding a full rebuild on");
    console.log("every step.");
}

main();