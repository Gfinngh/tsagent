import { readEventLog, type ReadEventLogOptions } from "./event-log.js";
import type { AgentEvent } from "./schemas.js";

/**
 * Derived final answer. `structured` carries the unwrapped user data
 * produced by the `final_answer` tool; `text` is the free-form assistant
 * reply that ends the run.
 */
export type FinalResult =
    | {
        kind: "structured";
        outputToolName: string;
        output: unknown;
        toolCallId: string;
    }
    | { kind: "text"; text: string; eventId: string };

/**
 * Event-sourced conversation. `events` *is* the conversation — there is no
 * parallel message history to keep in sync. `currentStep` and
 * `finalResult` are derived from `events`; they are never persisted
 * separately.
 */
export class ExecutionContext {
    readonly events: AgentEvent[];
    readonly outputToolName: string | null;
    private step: number;

    constructor(events: AgentEvent[] = [], outputToolName: string | null = null) {
        this.events = [...events];
        this.outputToolName = outputToolName;
        this.step = deriveStep(this.events);
    }

    /** Rehydrate from a decoded event list (use with `readEventLog`). */
    static fromEvents(
        events: AgentEvent[],
        outputToolName?: string,
    ): ExecutionContext {
        return new ExecutionContext(events, outputToolName ?? null);
    }

    /**
     * Rehydrate from a JSONL event log. Pass `outputToolName` for structured
     * runs — without it, a structured run whose last event is a `final_answer`
     * tool result looks unfinished, exactly as required by the source
     * invariant.
     */
    static fromLog(
        path: string,
        outputToolName?: string,
        options?: ReadEventLogOptions,
    ): ExecutionContext {
        const events = readEventLog(path, options);
        return new ExecutionContext(events, outputToolName ?? null);
    }

    get currentStep(): number {
        return this.step;
    }

    get finalResult(): FinalResult | null {
        return deriveFinalResult(this.events, this.outputToolName ?? undefined);
    }

    get isFinished(): boolean {
        return this.finalResult !== null;
    }

    addEvent(event: AgentEvent): void {
        this.events.push(event);
        this.step = deriveStep(this.events);
    }
}

/**
 * Count steps by counting events that carry an assistant message or a tool
 * call. A tool-result event that belongs to the same step does not count
 * again, and an event with both an assistant message and a tool call still
 * counts as one step.
 */
export function deriveStep(events: AgentEvent[]): number {
    let count = 0;
    for (const event of events) {
        if (isStepEvent(event)) count += 1;
    }
    return count;
}

function isStepEvent(event: AgentEvent): boolean {
    for (const item of event.content) {
        if (item.type === "tool_call") return true;
        if (item.type === "message" && item.message.role === "assistant") return true;
    }
    return false;
}

/**
 * Derive the final result:
 * - When `outputToolName` is provided, look for the last successful tool
 *   result with that name **in the current turn** (i.e. after the most
 *   recent user message) and unwrap its structured output.
 * - Otherwise, require the last event to contain an assistant message and
 *   no tool activity. A structured run whose last event is a tool result
 *   therefore looks unfinished without `outputToolName` — this is the
 *   invariant that lets `fromLog` detect the finished state correctly.
 *
 * The turn boundary matters for resume-with-follow-up: without it, a
 * completed `final_answer` from an earlier turn would be treated as the
 * final answer of the new turn and the loop would exit before the new
 * turn runs.
 */
export function deriveFinalResult(
    events: AgentEvent[],
    outputToolName: string | undefined,
): FinalResult | null {
    if (events.length === 0) return null;
    if (outputToolName !== undefined) {
        return findStructuredResult(events, outputToolName);
    }
    return findTextResult(events);
}

function findStructuredResult(
    events: AgentEvent[],
    outputToolName: string,
): FinalResult | null {
    const turnStart = findLastUserMessageIndex(events);

    for (let i = events.length - 1; i > turnStart; i -= 1) {
        const event = events[i];
        if (event === undefined) continue;
        for (let j = event.content.length - 1; j >= 0; j -= 1) {
            const item = event.content[j];
            if (item === undefined) continue;
            if (
                item.type === "tool_result" &&
                item.toolResult.name === outputToolName &&
                item.toolResult.status === "success"
            ) {
                return {
                    kind: "structured",
                    outputToolName,
                    output: extractStructuredOutput(item.toolResult.content),
                    toolCallId: item.toolResult.toolCallId,
                };
            }
        }
    }
    return null;
}

function findLastUserMessageIndex(events: AgentEvent[]): number {
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i];
        if (event === undefined) continue;
        for (const item of event.content) {
            if (item.type === "message" && item.message.role === "user") {
                return i;
            }
        }
    }
    return -1;
}

function findTextResult(events: AgentEvent[]): FinalResult | null {
    const last = events[events.length - 1];
    if (last === undefined) return null;
    for (const item of last.content) {
        if (item.type === "tool_call" || item.type === "tool_result") return null;
    }
    for (const item of last.content) {
        if (
            item.type === "message" &&
            item.message.role === "assistant" &&
            item.message.content !== null
        ) {
            return { kind: "text", text: item.message.content, eventId: last.id };
        }
    }
    return null;
}

/**
 * The `final_answer` tool wraps the user schema under a single `output`
 * key. Unwrap it when the shape is exactly `{ output: <data> }`; otherwise
 * return the value as-is so bare scalars and non-wrapped objects pass
 * through unchanged.
 */
function extractStructuredOutput(content: unknown[]): unknown {
    if (content.length === 0) return null;
    if (content.length === 1) {
        const single = content[0];
        if (
            single !== null &&
            typeof single === "object" &&
            !Array.isArray(single) &&
            Object.keys(single).length === 1 &&
            "output" in single
        ) {
            return (single as { output: unknown }).output;
        }
        return single;
    }
    return content;
}