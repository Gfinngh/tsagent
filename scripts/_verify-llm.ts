/**
 * Shared helpers for the LLM verification scripts. Not a framework — just
 * a couple of scripted transports that let us exercise retry, streaming,
 * and cancellation deterministically.
 */
import type { LlmErrorMetadata } from "../src/agent/llm.js";
import type {
    ChatMessage,
    LlmUsage,
    Transport,
    TransportResult,
} from "../src/agent/llm.js";
import { TransportError } from "../src/agent/llm.js";
import type { ToolDefinition } from "../src/agent/tools/base.js";
import type { ToolCall } from "../src/agent/schemas.js";

// Re-export `TransportError` so verification scripts can import their whole
// streaming/retry surface from one helper, without reaching into src/.
export { TransportError };

export interface ScriptedStep {
    result?: TransportResult;
    error?: TransportError;
    delayMs?: number;
}

/** A transport that returns a pre-scripted sequence of results/errors. */
export class ScriptedTransport implements Transport {
    readonly calls: Array<Parameters<Transport["call"]>[0]> = [];
    private readonly steps: ScriptedStep[];
    private cursor = 0;

    constructor(steps: ScriptedStep[]) {
        this.steps = steps;
    }

    async call(request: Parameters<Transport["call"]>[0]): Promise<TransportResult> {
        this.calls.push(request);
        const step = this.steps[this.cursor];
        this.cursor += 1;
        if (step === undefined) {
            throw new Error(`ScriptedTransport exhausted after ${this.cursor - 1} calls`);
        }
        if (step.delayMs !== undefined && step.delayMs > 0) {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, step.delayMs);
                if (request.signal !== undefined) {
                    request.signal.addEventListener(
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
        if (request.signal?.aborted === true) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
        }
        if (step.error !== undefined) throw step.error;
        if (step.result !== undefined) {
            if (request.onTextDelta !== undefined && step.result.text !== null) {
                request.onTextDelta(step.result.text);
            }
            return step.result;
        }
        throw new Error("ScriptedStep must have result or error");
    }
}

export function textResult(text: string): TransportResult {
    return {
        text,
        toolCalls: [],
        usage: defaultUsage(),
        providerOptions: {},
    };
}

export function toolCallResult(
    calls: ToolCall[],
    text: string | null = null,
): TransportResult {
    return {
        text,
        toolCalls: calls,
        usage: defaultUsage(),
        providerOptions: {},
    };
}

function defaultUsage(): LlmUsage {
    return { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
}

export function captureMessages(messages: ChatMessage[]): string {
    return JSON.stringify(messages);
}

export function toolDefinition(name: string): ToolDefinition {
    return {
        type: "function",
        function: {
            name,
            description: `test tool ${name}`,
            parameters: { type: "object", properties: {} },
        },
    };
}

// =========================================================================
// Streaming transport (fake)
// =========================================================================

export interface StreamStep {
    /** Chunks emitted through `onTextDelta` in order. */
    chunks: string[];
    /** Fully parsed tool calls returned after the stream completes. */
    toolCalls?: ToolCall[];
    /** Usage reported for the response. Defaults to a fixed value. */
    usage?: LlmUsage;
    /** Response-level provider options. Defaults to `{}`. */
    providerOptions?: Record<string, unknown>;
    /** Delay in ms between consecutive chunks. Defaults to 0. */
    delayBetweenChunksMs?: number;
    /** If set, thrown after the chunks are emitted. */
    error?: TransportError;
}

/**
 * A scripted streaming transport. Emits each chunk through
 * `request.onTextDelta` before returning the aggregate result, so tests
 * can verify both the per-chunk callback contract and the accumulated
 * `LlmResponse.text` produced by the real `LlmClient`.
 */
export class ScriptedStreamTransport implements Transport {
    readonly calls: Array<Parameters<Transport["call"]>[0]> = [];
    private readonly steps: StreamStep[];
    private cursor = 0;

    constructor(steps: StreamStep[]) {
        this.steps = steps;
    }

    async call(request: Parameters<Transport["call"]>[0]): Promise<TransportResult> {
        this.calls.push(request);
        const step = this.steps[this.cursor];
        this.cursor += 1;
        if (step === undefined) {
            throw new Error(
                `ScriptedStreamTransport exhausted after ${this.cursor - 1} calls`,
            );
        }
        if (request.onTextDelta === undefined) {
            throw new Error("ScriptedStreamTransport requires onTextDelta");
        }
        const delayMs = step.delayBetweenChunksMs ?? 0;
        const onTextDelta = request.onTextDelta;
        for (const chunk of step.chunks) {
            if (request.signal?.aborted === true) {
                const err = new Error("aborted");
                err.name = "AbortError";
                throw err;
            }
            if (delayMs > 0) {
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(resolve, delayMs);
                    if (request.signal !== undefined) {
                        const onAbort = () => {
                            clearTimeout(timer);
                            const err = new Error("aborted");
                            err.name = "AbortError";
                            reject(err);
                        };
                        if (request.signal.aborted) {
                            onAbort();
                        } else {
                            request.signal.addEventListener("abort", onAbort, { once: true });
                        }
                    }
                });
            }
            onTextDelta(chunk);
        }
        if (step.error !== undefined) throw step.error;
        const text = step.chunks.length === 0 ? null : step.chunks.join("");
        return {
            text,
            toolCalls: step.toolCalls ?? [],
            usage: step.usage ?? {
                promptTokens: 10,
                completionTokens: 20,
                totalTokens: 30,
            },
            providerOptions: step.providerOptions ?? {},
        };
    }
}

// =========================================================================
// Live-test helpers
// =========================================================================

/**
 * True when an `LlmErrorMetadata` describes a failure that should be
 * skipped (quota, rate limit, transient server error) rather than failed
 * — the same policy the Python source uses to tolerate flaky live calls.
 */
export function isTransientLlmError(
    message: string,
    metadata: LlmErrorMetadata,
): boolean {
    if (metadata.quotaExhausted === true) return true;
    if (metadata.rateLimited === true) return true;
    const status = metadata.statusCode;
    if (status === 408 || status === 429) return true;
    if (status !== undefined && status >= 500 && status < 600) return true;
    if (
        metadata.errorType === "quota" ||
        metadata.errorType === "rate_limit" ||
        metadata.errorType === "timeout" ||
        metadata.errorType === "network"
    ) {
        return true;
    }
    const lower = message.toLowerCase();
    return (
        lower.includes("quota") ||
        lower.includes("rate limit") ||
        lower.includes("rate_limit") ||
        lower.includes("timeout") ||
        lower.includes("timed out") ||
        lower.includes("resource_exhausted") ||
        lower.includes("high demand") ||
        lower.includes("unavailable") ||
        lower.includes("try again later") ||
        lower.includes("temporarily")
    );
}