import type {
    LlmClientProtocol,
    LlmErrorMetadata,
    LlmRequest,
    LlmResponse,
    LlmUsage,
} from "../src/agent/llm.js";
import type { ToolCall } from "../src/agent/schemas.js";
import { check } from "./_verify-common.js";

/**
 * A fake `LlmClientProtocol` that returns pre-scripted responses in order.
 * Records every request so tests can assert on the outgoing payload.
 */
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
                `ScriptedClient exhausted after ${this.cursor - 1} calls`,
            );
        }
        return response;
    }
}

function defaultUsage(): LlmUsage {
    return { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
}

export function textResponse(text: string): LlmResponse {
    return {
        text,
        toolCalls: [],
        usage: defaultUsage(),
        providerOptions: {},
        errorMessage: null,
        errorMetadata: {},
    };
}

export function toolCallResponse(
    toolCalls: ToolCall[],
    text: string | null = null,
): LlmResponse {
    return {
        text,
        toolCalls,
        usage: defaultUsage(),
        providerOptions: {},
        errorMessage: null,
        errorMetadata: {},
    };
}

export function errorResponse(
    message: string,
    metadata: LlmErrorMetadata = {},
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

export async function expectThrows<T extends Error>(
    fn: () => Promise<unknown>,
    ErrorClass: new (...args: never[]) => T,
    message: string,
): Promise<void> {
    try {
        await fn();
        check(false, `${message} (expected throw, got success)`);
    } catch (error) {
        const actual =
            error instanceof Error ? error.constructor.name : typeof error;
        check(error instanceof ErrorClass, `${message} (got ${actual})`);
    }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), ms);
        if (signal !== undefined) {
            if (signal.aborted) {
                clearTimeout(timer);
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
                return;
            }
            signal.addEventListener(
                "abort",
                () => {
                    clearTimeout(timer);
                    const err = new Error("aborted");
                    err.name = "AbortError";
                    reject(err);
                },
                { once: true },
            );
        }
    });
}

export function makeToolCall(
    id: string,
    name: string,
    args: Record<string, unknown> = {},
): ToolCall {
    return { id, name, arguments: args, providerOptions: null };
}