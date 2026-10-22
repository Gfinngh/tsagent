/**
 * Deterministic LLM client for examples that need to show
 * agent-loop mechanics without spending quota. This is a *demo* fake,
 * not test infrastructure — it does not assert anything, it just
 * replays a scripted sequence so the reader can see what the real
 * agent loop does with a known input.
 *
 * The `verify:*` suite has its own `ScriptedClient` under
 * `scripts/_verify-agent.ts`. Keep them separate — the examples one
 * can evolve independently, and both being small makes the intent
 * clearer than a shared helper.
 */

import type {
    LlmClientProtocol,
    LlmRequest,
    LlmResponse,
    LlmUsage,
} from "../src/agent/llm.js";
import type { ToolCall } from "../src/agent/schemas.js";

export class ScriptedClient implements LlmClientProtocol {
    readonly calls: LlmRequest[] = [];
    private readonly responses: LlmResponse[];
    private cursor = 0;

    constructor(responses: LlmResponse[]) {
        this.responses = responses;
    }

    async generate(request: LlmRequest): Promise<LlmResponse> {
        this.calls.push(request);
        const response = this.responses[this.cursor];
        this.cursor += 1;
        if (response === undefined) {
            throw new Error(
                `ScriptedClient exhausted after ${this.cursor - 1} call(s); add more responses`,
            );
        }
        return response;
    }
}

const DEFAULT_USAGE: LlmUsage = {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
};

/** A text-only response. */
export function textResponse(text: string): LlmResponse {
    return {
        text,
        toolCalls: [],
        usage: DEFAULT_USAGE,
        providerOptions: {},
        errorMessage: null,
        errorMetadata: {},
    };
}

/** A response that emits one or more tool calls. */
export function toolCallResponse(
    toolCalls: ToolCall[],
    text: string | null = null,
): LlmResponse {
    return {
        text,
        toolCalls,
        usage: DEFAULT_USAGE,
        providerOptions: {},
        errorMessage: null,
        errorMetadata: {},
    };
}

/** A response reporting an error. */
export function errorResponse(
    message: string,
    metadata: Record<string, unknown> = {},
): LlmResponse {
    return {
        text: null,
        toolCalls: [],
        usage: null,
        providerOptions: {},
        errorMessage: message,
        errorMetadata: metadata,
    };
}

/** Build a `ToolCall` value. */
export function makeToolCall(
    id: string,
    name: string,
    args: Record<string, unknown> = {},
): ToolCall {
    return { id, name, arguments: args, providerOptions: null };
}