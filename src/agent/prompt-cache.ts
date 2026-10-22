/**
 * Incremental prompt builder.
 *
 * `PromptCache` maintains the `ChatMessage[]` that
 * `buildMessages(instructions, events)` would produce for the events
 * seen so far, and extends it as new events arrive. Old snapshots are
 * not affected by later extensions — that guarantee comes from
 * `appendToolCall` in `llm.ts` creating a replacement assistant message
 * instead of mutating in place.
 *
 * Why this exists: the agent calls the LLM once per step, and
 * `buildMessages` was being called from scratch each time. For a
 * tool-heavy run, `toolResultOutput` re-serializes every tool result on
 * every step — a real cost even if the overall run is small.
 * `PromptCache` avoids that by keeping the built array around and only
 * appending the delta.
 *
 * Usage:
 *   const cache = new PromptCache(instructions);
 *   for each step:
 *     const messages = cache.build(context.events);
 *     // pass `messages` as `prebuiltMessages` on the request
 *
 * Correctness invariant: for any `events`, `cache.build(events)` must
 * be structurally identical to `buildMessages(instructions, events)`.
 * This is verified by `verify:prompt-cache`.
 */

import {
    buildMessages,
    appendContentItem,
    type ChatMessage,
} from "./llm.js";
import type { AgentEvent } from "./schemas.js";

export class PromptCache {
    private readonly instructions: string[];
    private messages: ChatMessage[];
    private builtEventCount: number;
    private initialized: boolean;

    constructor(instructions: string[]) {
        this.instructions = instructions;
        this.messages = [];
        this.builtEventCount = 0;
        this.initialized = false;
    }

    /**
     * Return the built messages for `events`. The returned array is a
     * fresh snapshot — extending the cache later (via a subsequent
     * `build` with more events) does not modify the returned array or its
     * contained ChatMessage objects.
     */
    build(events: AgentEvent[]): ChatMessage[] {
        if (!this.initialized) {
            this.messages = buildMessages(this.instructions, events);
            this.builtEventCount = events.length;
            this.initialized = true;
            return [...this.messages];
        }

        if (events.length > this.builtEventCount) {
            for (let i = this.builtEventCount; i < events.length; i += 1) {
                const event = events[i];
                if (event === undefined) continue;
                for (const item of event.content) {
                    appendContentItem(this.messages, item);
                }
            }
            this.builtEventCount = events.length;
        }

        return [...this.messages];
    }
}