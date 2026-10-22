import {
    type LlmClientProtocol,
    type LlmErrorMetadata,
    type LlmRequest,
    type LlmResponse,
} from "./llm.js";
import { decodeThoughtId } from "./provider-options.js";
import type {
    AgentEvent,
    ContentItem,
    Message,
    ToolCall,
    ToolResult,
} from "./schemas.js";
import {
    isAbortError,
    makeAbortError,
    mergeSignals,
} from "./signals.js";

// =========================================================================
// Public types
// =========================================================================

export type FallbackDecision = "fallback" | "terminal";

export interface FallbackPolicy {
    /**
     * Given a failed response (i.e. `errorMessage !== null`), return
     * `"fallback"` to advance to the next entry, or `"terminal"` to return
     * the failure as-is.
     */
    decide(response: LlmResponse): FallbackDecision;
}

export interface FallbackEntry {
    /** Human-readable name used in metadata (`fallbackFrom`, `fallbackTried`). */
    name: string;
    client: LlmClientProtocol;
}

export interface FallbackClientOptions {
    entries: FallbackEntry[];
    policy?: FallbackPolicy;
    /**
     * When true, provider options (`providerOptions` on assistant messages
     * and tool calls, plus the `__thought__` suffix in tool-call IDs) are
     * stripped before re-issuing the request to any client after the first.
     * Signatures are provider-specific, so they must not leak across
     * providers on a chain switch.
     */
    stripProviderOptionsOnSwitch?: boolean;
    /** Total wall-clock budget across the entire chain. */
    chainTimeoutMs?: number | null;
}

/**
 * The default policy. Fallback on quota / rate limit / timeout / server
 * errors; everything else (auth, bad request, not found, context window,
 * cancellation, unknown) is terminal. Matches the source project's
 * documented default:
 *   "quota, rate-limit, 408, ≥500 → fallback; anything else → terminal."
 */
export function defaultFallbackPolicy(): FallbackPolicy {
    return {
        decide(response) {
            if (response.errorMessage === null) return "terminal";
            const kind = response.errorMetadata.errorType;
            switch (kind) {
                case "quota":
                case "rate_limit":
                case "server":
                case "timeout":
                    return "fallback";
                default:
                    return "terminal";
            }
        },
    };
}

// =========================================================================
// FallbackClient
// =========================================================================

class ChainTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number) {
        super(`fallback chain timed out after ${timeoutMs}ms`);
        this.name = "ChainTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}

export class FallbackClient implements LlmClientProtocol {
    readonly entries: FallbackEntry[];
    private readonly policy: FallbackPolicy;
    private readonly stripOptions: boolean;
    private readonly chainTimeoutMs: number | null;

    constructor(options: FallbackClientOptions) {
        if (options.entries.length === 0) {
            throw new Error("FallbackClient requires at least one entry");
        }
        this.entries = options.entries;
        this.policy = options.policy ?? defaultFallbackPolicy();
        this.stripOptions = options.stripProviderOptionsOnSwitch ?? false;
        this.chainTimeoutMs = options.chainTimeoutMs ?? null;
    }

    async generate(request: LlmRequest): Promise<LlmResponse> {
        const controller = new AbortController();
        const callerSignal = request.signal;
        const chainSignal =
            callerSignal !== undefined
                ? mergeSignals(controller.signal, callerSignal)
                : controller.signal;

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let chainTimedOut = false;
        if (this.chainTimeoutMs !== null) {
            const ms = this.chainTimeoutMs;
            timeoutHandle = setTimeout(() => {
                chainTimedOut = true;
                controller.abort(new ChainTimeoutError(ms));
            }, ms);
        }

        const tried: string[] = [];
        let lastFailure: LlmResponse | null = null;
        let lastFrom: string | null = null;

        try {
            for (let i = 0; i < this.entries.length; i += 1) {
                if (chainSignal.aborted) {
                    if (callerSignal?.aborted === true) throw makeAbortError();
                    return this.buildChainTimeoutResponse(tried, lastFrom, lastFailure);
                }

                const entry = this.entries[i]!;
                tried.push(entry.name);

                const requestForThisClient: LlmRequest = {
                    ...request,
                    signal: chainSignal,
                    ...(i > 0 && this.stripOptions
                        ? { events: stripProviderOptionsFromEvents(request.events) }
                        : {}),
                };

                let response: LlmResponse;
                try {
                    response = await entry.client.generate(requestForThisClient);
                } catch (error) {
                    if (isAbortError(error)) {
                        if (callerSignal?.aborted === true) throw error;
                        if (chainTimedOut) {
                            return this.buildChainTimeoutResponse(tried, lastFrom, lastFailure);
                        }
                        throw error;
                    }
                    throw error;
                }

                if (response.errorMessage === null) {
                    return this.enrichSuccess(response, tried, lastFrom, entry.name);
                }

                lastFailure = response;
                lastFrom = entry.name;
                const decision = this.policy.decide(response);

                if (decision === "terminal") {
                    return this.enrichTerminal(response, tried, lastFrom);
                }

                if (chainTimedOut) {
                    return this.buildChainTimeoutResponse(tried, lastFrom, response);
                }

                if (i === this.entries.length - 1) {
                    return this.enrichExhausted(response, tried, lastFrom);
                }
            }
        } finally {
            if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        }

        // Unreachable — the loop either returns or throws on every path.
        return this.buildChainTimeoutResponse(tried, lastFrom, lastFailure);
    }

    // -----------------------------------------------------------------------
    // Metadata enrichment
    // -----------------------------------------------------------------------

    private enrichSuccess(
        response: LlmResponse,
        tried: string[],
        lastFrom: string | null,
        landedOn: string,
    ): LlmResponse {
        const metadata: LlmErrorMetadata = {
            ...response.errorMetadata,
            fallbackUsed: lastFrom !== null,
            fallbackLandedOn: landedOn,
            fallbackChainLength: this.entries.length,
            fallbackTried: tried,
        };
        if (lastFrom !== null) metadata.fallbackFrom = lastFrom;
        return { ...response, errorMetadata: metadata };
    }

    private enrichTerminal(
        response: LlmResponse,
        tried: string[],
        lastFrom: string,
    ): LlmResponse {
        const metadata: LlmErrorMetadata = {
            ...response.errorMetadata,
            fallbackUsed: tried.length > 1,
            fallbackSkippedByPolicy: true,
            fallbackChainLength: this.entries.length,
            fallbackTried: tried,
        };
        if (tried.length > 1) metadata.fallbackFrom = lastFrom;
        return { ...response, errorMetadata: metadata };
    }

    private enrichExhausted(
        response: LlmResponse,
        tried: string[],
        lastFrom: string,
    ): LlmResponse {
        const metadata: LlmErrorMetadata = {
            ...response.errorMetadata,
            fallbackUsed: tried.length > 1,
            fallbackExhausted: true,
            fallbackChainLength: this.entries.length,
            fallbackTried: tried,
        };
        if (tried.length > 1) metadata.fallbackFrom = lastFrom;
        return { ...response, errorMetadata: metadata };
    }

    private buildChainTimeoutResponse(
        tried: string[],
        lastFrom: string | null,
        lastFailure: LlmResponse | null,
    ): LlmResponse {
        const ms = this.chainTimeoutMs ?? 0;
        const metadata: LlmErrorMetadata = {
            ...(lastFailure?.errorMetadata ?? {}),
            fallbackUsed: tried.length > 1,
            fallbackAborted: true,
            fallbackChainLength: this.entries.length,
            fallbackTried: tried,
            timeoutMs: ms,
            retryReason: "chainTimeout",
        };
        if (lastFrom !== null) metadata.fallbackFrom = lastFrom;
        return {
            text: null,
            toolCalls: [],
            usage: null,
            providerOptions: {},
            errorMessage: `fallback chain timed out after ${ms}ms`,
            errorMetadata: metadata,
        };
    }
}

// =========================================================================
// Provider-option stripping
// =========================================================================

/**
 * Return a deep-cloned event list where every provider-options channel
 * has been removed:
 *   - `providerOptions` on `Message` objects → `{}`
 *   - `providerOptions` on `ToolCall` objects → `null`
 *   - `__thought__{sig}` suffix on tool-call IDs → stripped to base ID
 *
 * Both the `tool_call` content item's `id` and any `tool_result`'s
 * `toolCallId` referencing it are stripped together, so results stay
 * linked to their calls.
 *
 * The original events are not mutated; this returns fresh copies.
 */
export function stripProviderOptionsFromEvents(
    events: AgentEvent[],
): AgentEvent[] {
    return events.map(stripEvent);
}

function stripEvent(event: AgentEvent): AgentEvent {
    return { ...event, content: event.content.map(stripContentItem) };
}

function stripContentItem(item: ContentItem): ContentItem {
    switch (item.type) {
        case "tool_call":
            return { type: "tool_call", toolCall: stripToolCall(item.toolCall) };
        case "tool_result":
            return { type: "tool_result", toolResult: stripToolResult(item.toolResult) };
        case "message":
            return { type: "message", message: stripMessage(item.message) };
    }
}

function stripMessage(message: Message): Message {
    return {
        ...message,
        toolCalls: message.toolCalls.map(stripToolCall),
        providerOptions: {},
    };
}

function stripToolCall(toolCall: ToolCall): ToolCall {
    return {
        ...toolCall,
        id: stripThoughtSuffix(toolCall.id),
        providerOptions: null,
    };
}

function stripToolResult(toolResult: ToolResult): ToolResult {
    return {
        ...toolResult,
        toolCallId: stripThoughtSuffix(toolResult.toolCallId),
    };
}

function stripThoughtSuffix(id: string): string {
    const decoded = decodeThoughtId(id);
    return decoded !== null ? decoded.baseId : id;
}