import {
    MultipartContentSchema,
    MultipartPartSchema,
    type AgentEvent,
    type ContentItem,
    type Message,
    type ToolCall,
    type ToolResult,
} from "./schemas.js";
import type { ToolDefinition } from "./tools/base.js";
export type { ToolDefinition };

// =========================================================================
// Public request / response shapes
// =========================================================================

export type ChatMessage =
    | { role: "system"; content: string }
    | {
        role: "user";
        content: string;
        providerOptions?: Record<string, unknown>;
    }
    | {
        role: "assistant";
        content: string | null;
        toolCalls?: Array<{
            id: string;
            name: string;
            arguments: Record<string, unknown>;
            providerOptions?: Record<string, unknown> | null;
        }>;
        providerOptions?: Record<string, unknown>;
    }
    | {
        role: "tool";
        toolCallId: string;
        name: string;
        content: string;
    };

export interface LlmRequest {
    instructions: string[];
    events: AgentEvent[];
    tools?: ToolDefinition[];
    toolChoice?: "auto" | "required" | "none" | { type: "function"; name: string };
    /** Per-request override of the client's default mode. */
    mode?: string;
    providerOptions?: Record<string, unknown>;
    /** Streaming callback. When supplied, streaming is used. */
    onTextDelta?: (delta: string) => void;
    /** Aborts in-flight transport work. */
    signal?: AbortSignal;
    /**
     * Pre-built messages. When set, `LlmClient.generate` uses this array
     * instead of calling `buildMessages(instructions, events)` — a cost
     * saving for agents that maintain an incremental cache (see
     * `PromptCache` in `prompt-cache.ts`).
     *
     * The array must be structurally identical to what
     * `buildMessages(instructions, events)` would produce for the same
     * inputs. Callers are responsible for providing a snapshot (a fresh
     * array reference) so that later mutations of an internal cache do
     * not appear on captured request payloads.
     */
    prebuiltMessages?: ChatMessage[];
}

export interface LlmUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface LlmErrorMetadata {
    statusCode?: number;
    providerStatus?: string;
    providerCode?: string;
    retryable?: boolean;
    rateLimited?: boolean;
    quotaExhausted?: boolean;
    retryAfterMs?: number;
    errorType?: string;
    providerData?: Record<string, unknown>;
    attempts?: number;
    retryExhausted?: boolean;
    retryReason?: string;
    timeoutMs?: number;
    // Fallback chain metadata. Present on responses returned by
    // FallbackClient regardless of success/failure so observers can see
    // which entry served the response.
    fallbackUsed?: boolean;
    fallbackFrom?: string;
    fallbackLandedOn?: string;
    fallbackExhausted?: boolean;
    fallbackSkippedByPolicy?: boolean;
    fallbackAborted?: boolean;
    fallbackChainLength?: number;
    fallbackTried?: string[];
}

export interface LlmResponse {
    text: string | null;
    toolCalls: ToolCall[];
    usage: LlmUsage | null;
    providerOptions: Record<string, unknown>;
    errorMessage: string | null;
    errorMetadata: LlmErrorMetadata;
}

export interface LlmClientProtocol {
    generate(request: LlmRequest): Promise<LlmResponse>;
}

// =========================================================================
// Transport seam (for deterministic verification)
// =========================================================================

/**
 * One shot at talking to the provider. The retry loop lives *above* this
 * seam, so tests can script raw provider responses without simulating
 * backoff or classification.
 */
export interface TransportResult {
    text: string | null;
    toolCalls: ToolCall[];
    usage: LlmUsage | null;
    providerOptions: Record<string, unknown>;
}

export class TransportError extends Error {
    readonly statusCode: number | null;
    readonly providerStatus: string | null;
    readonly providerCode: string | null;
    readonly providerData: Record<string, unknown> | null;
    readonly retryAfterMs: number | null;

    constructor(
        message: string,
        options: {
            statusCode?: number | null;
            providerStatus?: string | null;
            providerCode?: string | null;
            providerData?: Record<string, unknown> | null;
            retryAfterMs?: number | null;
        } = {},
    ) {
        super(message);
        this.name = "TransportError";
        this.statusCode = options.statusCode ?? null;
        this.providerStatus = options.providerStatus ?? null;
        this.providerCode = options.providerCode ?? null;
        this.providerData = options.providerData ?? null;
        this.retryAfterMs = options.retryAfterMs ?? null;
    }
}

export interface Transport {
    call(request: {
        messages: ChatMessage[];
        tools?: ToolDefinition[];
        toolChoice?: LlmRequest["toolChoice"];
        mode: string;
        providerOptions?: Record<string, unknown>;
        onTextDelta?: (delta: string) => void;
        signal?: AbortSignal;
    }): Promise<TransportResult>;
}

export type RequestCapture = (payload: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    toolChoice?: LlmRequest["toolChoice"];
    mode: string;
    providerOptions?: Record<string, unknown>;
}) => void;

// =========================================================================
// Client options
// =========================================================================

export interface LlmClientOptions {
    model: string;
    transport: Transport;
    mode?: string;
    maxRetries?: number;
    timeoutMs?: number | null;
    captureRequest?: RequestCapture;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
}

// =========================================================================
// Error classification
// =========================================================================

export type ErrorKind =
    | "auth"
    | "quota"
    | "rate_limit"
    | "server"
    | "bad_request"
    | "not_found"
    | "context_window"
    | "timeout"
    | "network"
    | "cancelled"
    | "unknown";

export interface ClassifiedError {
    kind: ErrorKind;
    retryable: boolean;
    rateLimited: boolean;
    quotaExhausted: boolean;
    retryAfterMs: number | null;
    statusCode: number | null;
    providerStatus: string | null;
    providerCode: string | null;
    providerData: Record<string, unknown> | null;
    message: string;
}

const TERMINAL_CODES = new Set([
    "insufficient_quota",
    "QUOTA_EXCEEDED",
    "API_KEY_INVALID",
    "PERMISSION_DENIED",
]);

const CONTEXT_WINDOW_HINTS = [
    "context length",
    "context window",
    "maximum context",
    "too many tokens",
    "input is too long",
];

const QUOTA_HINTS = ["quota", "resource_exhausted", "resource exhausted"];

const LONG_RETRY_DELAY_THRESHOLD_MS = 60_000;

export function classifyError(error: unknown): ClassifiedError {
    if (error instanceof TransportError) {
        return classifyTransport(error);
    }
    if (error instanceof Error) {
        if (error.name === "AbortError") {
            return base(error.message, "cancelled", {
                retryable: false,
                statusCode: null,
            });
        }
        if (isNetworkError(error)) {
            return base(error.message, "network", { retryable: true });
        }
        return base(error.message, "unknown", { retryable: false });
    }
    return base(String(error), "unknown", { retryable: false });
}

function classifyTransport(error: TransportError): ClassifiedError {
    const status = error.statusCode;
    const lowerMessage = error.message.toLowerCase();
    const providerCode = error.providerCode;
    const providerStatus = error.providerStatus;

    // Provider-code terminal cases — regardless of status code.
    if (providerCode !== null && TERMINAL_CODES.has(providerCode)) {
        return base(error.message, "quota", {
            retryable: false,
            quotaExhausted: true,
            statusCode: status,
            providerStatus,
            providerCode,
            providerData: error.providerData,
        });
    }

    // RESOURCE_EXHAUSTED: distinguish short retry from terminal quota.
    if (
        (providerStatus === "RESOURCE_EXHAUSTED" || providerCode === "RESOURCE_EXHAUSTED") &&
        status === 429
    ) {
        const retryAfter = error.retryAfterMs;
        if (retryAfter !== null && retryAfter > LONG_RETRY_DELAY_THRESHOLD_MS) {
            return base(error.message, "quota", {
                retryable: false,
                quotaExhausted: true,
                statusCode: status,
                providerStatus,
                providerCode,
                providerData: error.providerData,
                retryAfterMs: retryAfter,
            });
        }
        return base(error.message, "rate_limit", {
            retryable: true,
            rateLimited: true,
            statusCode: status,
            providerStatus,
            providerCode,
            providerData: error.providerData,
            retryAfterMs: retryAfter,
        });
    }

    // 403 with quota signals is reclassified as a 429-style rate limit.
    if (
        status === 403 &&
        (lowerMessage.includes("quota") || lowerMessage.includes("resource_exhausted"))
    ) {
        return base(error.message, "rate_limit", {
            retryable: true,
            rateLimited: true,
            statusCode: status,
            providerStatus,
            providerCode,
            providerData: error.providerData,
            retryAfterMs: error.retryAfterMs,
        });
    }

    // Context-window hints beat status-code heuristics.
    if (CONTEXT_WINDOW_HINTS.some((hint) => lowerMessage.includes(hint))) {
        return base(error.message, "context_window", {
            retryable: false,
            statusCode: status,
            providerStatus,
            providerCode,
            providerData: error.providerData,
        });
    }

    if (QUOTA_HINTS.some((hint) => lowerMessage.includes(hint))) {
        return base(error.message, "quota", {
            retryable: false,
            quotaExhausted: true,
            statusCode: status,
            providerStatus,
            providerCode,
            providerData: error.providerData,
        });
    }

    if (status === null) {
        return base(error.message, "unknown", { retryable: false });
    }

    if (status === 401) {
        return base(error.message, "auth", {
            retryable: false,
            statusCode: status,
            providerStatus,
            providerCode,
            providerData: error.providerData,
        });
    }

    if (status === 403) {
        return base(error.message, "auth", {
            retryable: false,
            statusCode: status,
            providerStatus,
            providerCode,
            providerData: error.providerData,
        });
    }

    if (status === 404) {
        return base(error.message, "not_found", {
            retryable: false,
            statusCode: status,
            providerStatus,
            providerCode,
            providerData: error.providerData,
        });
    }

    if (status === 408) {
        return base(error.message, "timeout", {
            retryable: true,
            statusCode: status,
            providerStatus,
            providerCode,
            providerData: error.providerData,
            retryAfterMs: error.retryAfterMs,
        });
    }

    if (status === 429) {
        return base(error.message, "rate_limit", {
            retryable: true,
            rateLimited: true,
            statusCode: status,
            providerStatus,
            providerCode,
            providerData: error.providerData,
            retryAfterMs: error.retryAfterMs,
        });
    }

    if (status >= 500 && status < 600) {
        return base(error.message, "server", {
            retryable: true,
            statusCode: status,
            providerStatus,
            providerCode,
            providerData: error.providerData,
        });
    }

    if (status === 400 || status === 422) {
        return base(error.message, "bad_request", {
            retryable: false,
            statusCode: status,
            providerStatus,
            providerCode,
            providerData: error.providerData,
        });
    }

    return base(error.message, "unknown", {
        retryable: false,
        statusCode: status,
        providerStatus,
        providerCode,
        providerData: error.providerData,
    });
}

function base(
    message: string,
    kind: ErrorKind,
    overrides: Partial<ClassifiedError>,
): ClassifiedError {
    return {
        kind,
        retryable: false,
        rateLimited: false,
        quotaExhausted: false,
        retryAfterMs: null,
        statusCode: null,
        providerStatus: null,
        providerCode: null,
        providerData: null,
        message,
        ...overrides,
    };
}

function isNetworkError(error: Error): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return (
        code === "ECONNRESET" ||
        code === "ECONNREFUSED" ||
        code === "ETIMEDOUT" ||
        code === "ENOTFOUND" ||
        code === "EAI_AGAIN" ||
        /network|socket hang up|fetch failed/i.test(error.message)
    );
}

// =========================================================================
// Backoff
// =========================================================================

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

export function computeBackoff(
    attempt: number,
    random: () => number = Math.random,
): number {
    const raw = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
    const jitter = (random() * 2 - 1) * 0.25 * raw;
    return Math.max(1, Math.round(raw + jitter));
}

// =========================================================================
// Prompt building
// =========================================================================

export function buildMessages(
    instructions: string[],
    events: AgentEvent[],
): ChatMessage[] {
    const messages: ChatMessage[] = [];

    if (instructions.length > 0) {
        messages.push({
            role: "system",
            content: instructions.join("\n\n"),
        });
    }

    for (const event of events) {
        for (const item of event.content) {
            appendContentItem(messages, item);
        }
    }

    return messages;
}

/**
 * Append one content item to `messages`, in place. Exported so
 * `PromptCache` can extend a cached array incrementally without
 * re-serializing old events. Callers who use this to extend a cache
 * that has already been snapshotted can rely on the guarantee that
 * `appendToolCall` creates a replacement assistant message rather than
 * mutating an existing one — old snapshots are never retroactively
 * affected by a later append.
 */
export function appendContentItem(
    messages: ChatMessage[],
    item: ContentItem,
): void {
    if (item.type === "message") {
        appendMessage(messages, item.message);
        return;
    }
    if (item.type === "tool_call") {
        appendToolCall(messages, item.toolCall);
        return;
    }
    appendToolResult(messages, item.toolResult);
}

function appendMessage(messages: ChatMessage[], message: Message): void {
    if (message.role === "system") {
        messages.push({ role: "system", content: message.content ?? "" });
        return;
    }
    if (message.role === "user") {
        const userMessage: ChatMessage = {
            role: "user",
            content: message.content ?? "",
        };
        if (Object.keys(message.providerOptions).length > 0) {
            (userMessage as { providerOptions?: Record<string, unknown> }).providerOptions =
                message.providerOptions;
        }
        messages.push(userMessage);
        return;
    }
    if (message.role === "assistant") {
        const assistantMessage: ChatMessage = {
            role: "assistant",
            content: message.content,
        };
        if (Object.keys(message.providerOptions).length > 0) {
            (assistantMessage as { providerOptions?: Record<string, unknown> }).providerOptions =
                message.providerOptions;
        }
        messages.push(assistantMessage);
        return;
    }
    // role === "tool" — emitted by appendToolResult, not here.
}

function appendToolCall(messages: ChatMessage[], toolCall: ToolCall): void {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") {
        const existing = last.toolCalls ?? [];
        // Replace rather than mutate so cached snapshots are never
        // retroactively affected by a subsequent append. See the doc
        // comment on `appendContentItem`.
        const replacement: Extract<ChatMessage, { role: "assistant" }> = {
            role: "assistant",
            content: last.content,
            toolCalls: [
                ...existing,
                {
                    id: toolCall.id,
                    name: toolCall.name,
                    arguments: toolCall.arguments,
                    providerOptions: toolCall.providerOptions,
                },
            ],
        };
        if (last.providerOptions !== undefined) {
            replacement.providerOptions = last.providerOptions;
        }
        messages[messages.length - 1] = replacement;
        return;
    }
    messages.push({
        role: "assistant",
        content: null,
        toolCalls: [
            {
                id: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
                providerOptions: toolCall.providerOptions,
            },
        ],
    });
}

function appendToolResult(messages: ChatMessage[], result: ToolResult): void {
    messages.push({
        role: "tool",
        toolCallId: result.toolCallId,
        name: result.name,
        content: toolResultOutput(result.content),
    });
}

// =========================================================================
// Tool-result normalization
// =========================================================================

export function toolResultOutput(content: unknown[]): string {
    const parts: string[] = [];
    for (const item of content) {
        parts.push(stringifyContentItem(item));
    }
    return parts.join("\n");
}

function stringifyContentItem(item: unknown): string {
    if (item === null || item === undefined) return String(item);
    if (typeof item === "string") return item;
    if (typeof item === "number" || typeof item === "boolean" || typeof item === "bigint") {
        return String(item);
    }
    if (typeof item === "object" && item !== null) {
        // Whole MultipartContent — flatten its parts.
        const mp = MultipartContentSchema.safeParse(item);
        if (mp.success) {
            return mp.data.parts.map(stringifyMultipartPart).join("\n");
        }
        // Bare MultipartPart — this is what the MCP boundary produces for a
        // single-content tool result. Handle it explicitly so a lone text
        // part stringifies to its text, not to JSON.
        const part = MultipartPartSchema.safeParse(item);
        if (part.success) {
            return stringifyMultipartPart(part.data);
        }
        return JSON.stringify(item, null, 2);
    }
    return String(item);
}

function stringifyMultipartPart(part: unknown): string {
    if (part === null || typeof part !== "object") return String(part);
    const p = part as Record<string, unknown>;
    const type = p.type;
    if (type === "text" && typeof p.text === "string") return p.text;
    if (type === "image") {
        const mimeType = typeof p.mimeType === "string" ? p.mimeType : "application/octet-stream";
        const data = typeof p.data === "string" ? p.data : "";
        return `[image: ${mimeType}, ${Buffer.byteLength(data, "base64")} bytes base64]`;
    }
    if (type === "resource") {
        const uri = typeof p.uri === "string" ? p.uri : "";
        const mimeType = typeof p.mimeType === "string" ? p.mimeType : null;
        const text = typeof p.text === "string" ? p.text : null;
        const blob = typeof p.blob === "string" ? p.blob : null;
        const header = mimeType !== null ? `[resource: ${uri} (${mimeType})]` : `[resource: ${uri}]`;
        if (text !== null) return `${header}\n${text}`;
        if (blob !== null) return `${header}\n[base64: ${Buffer.byteLength(blob, "base64")} bytes]`;
        return header;
    }
    if (type === "structured") {
        return JSON.stringify(p.data, null, 2);
    }
    return JSON.stringify(part, null, 2);
}

// =========================================================================
// LlmClient
// =========================================================================

export class LlmClient implements LlmClientProtocol {
    readonly model: string;
    private readonly transport: Transport;
    private readonly defaultMode: string;
    private readonly maxRetries: number;
    private readonly timeoutMs: number | null;
    private readonly captureRequest: RequestCapture | null;
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    private readonly random: () => number;

    constructor(options: LlmClientOptions) {
        this.model = options.model;
        this.transport = options.transport;
        this.defaultMode = options.mode ?? "chat";
        this.maxRetries = options.maxRetries ?? 2;
        this.timeoutMs = options.timeoutMs ?? null;
        this.captureRequest = options.captureRequest ?? null;
        this.sleep = options.sleep ?? defaultSleep;
        this.random = options.random ?? Math.random;
    }

    async generate(request: LlmRequest): Promise<LlmResponse> {
        const messages =
            request.prebuiltMessages ?? buildMessages(request.instructions, request.events);
        const mode = request.mode ?? this.defaultMode;

        if (this.captureRequest !== null) {
            const captured: Parameters<RequestCapture>[0] = { messages, mode };
            if (request.tools !== undefined) captured.tools = request.tools;
            if (request.toolChoice !== undefined) captured.toolChoice = request.toolChoice;
            if (request.providerOptions !== undefined) {
                captured.providerOptions = request.providerOptions;
            }
            this.captureRequest(captured);
        }

        const totalAttempts = this.maxRetries + 1;
        const startTime = Date.now();
        let lastMetadata: LlmErrorMetadata = {};

        for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
            try {
                const result = await this.callTransport({
                    messages,
                    mode,
                    ...(request.tools !== undefined ? { tools: request.tools } : {}),
                    ...(request.toolChoice !== undefined ? { toolChoice: request.toolChoice } : {}),
                    ...(request.providerOptions !== undefined
                        ? { providerOptions: request.providerOptions }
                        : {}),
                    ...(request.onTextDelta !== undefined ? { onTextDelta: request.onTextDelta } : {}),
                    ...(request.signal !== undefined ? { signal: request.signal } : {}),
                });
                return {
                    text: result.text,
                    toolCalls: result.toolCalls,
                    usage: result.usage,
                    providerOptions: result.providerOptions,
                    errorMessage: null,
                    errorMetadata: { attempts: attempt },
                };
            } catch (error) {
                if (isAbort(error, request.signal)) {
                    throw error;
                }
                const classified = classifyError(error);
                lastMetadata = metadataFromClassified(classified, attempt);

                if (!classified.retryable || attempt === totalAttempts) {
                    return {
                        text: null,
                        toolCalls: [],
                        usage: null,
                        providerOptions: {},
                        errorMessage: classified.message,
                        errorMetadata: {
                            ...lastMetadata,
                            retryExhausted: attempt === totalAttempts,
                        },
                    };
                }

                const backoff = computeBackoff(attempt, this.random);
                if (this.timeoutMs !== null) {
                    const elapsed = Date.now() - startTime;
                    if (elapsed + backoff > this.timeoutMs) {
                        return {
                            text: null,
                            toolCalls: [],
                            usage: null,
                            providerOptions: {},
                            errorMessage: classified.message,
                            errorMetadata: {
                                ...lastMetadata,
                                retryExhausted: true,
                                retryReason: "timeoutBeforeRetry",
                                timeoutMs: this.timeoutMs,
                            },
                        };
                    }
                }
                await this.sleep(backoff, request.signal);
            }
        }

        // Unreachable: the loop either returns or throws on every path.
        return {
            text: null,
            toolCalls: [],
            usage: null,
            providerOptions: {},
            errorMessage: "retry loop exhausted without a response",
            errorMetadata: lastMetadata,
        };
    }

    private async callTransport(payload: Parameters<Transport["call"]>[0]) {
        if (this.timeoutMs === null) {
            return this.transport.call(payload);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            return await this.transport.call({
                ...payload,
                signal: mergeSignals(controller.signal, payload.signal),
            });
        } catch (error) {
            if (controller.signal.aborted && !isAbort(error, payload.signal)) {
                throw new TransportError("request timed out", { statusCode: 408 });
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}

function metadataFromClassified(
    classified: ClassifiedError,
    attempt: number,
): LlmErrorMetadata {
    const metadata: LlmErrorMetadata = {
        attempts: attempt,
        retryable: classified.retryable,
        rateLimited: classified.rateLimited,
        quotaExhausted: classified.quotaExhausted,
        errorType: classified.kind,
    };
    if (classified.statusCode !== null) metadata.statusCode = classified.statusCode;
    if (classified.providerStatus !== null) metadata.providerStatus = classified.providerStatus;
    if (classified.providerCode !== null) metadata.providerCode = classified.providerCode;
    if (classified.retryAfterMs !== null) metadata.retryAfterMs = classified.retryAfterMs;
    if (classified.providerData !== null) metadata.providerData = classified.providerData;
    return metadata;
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
    if (error instanceof Error && error.name === "AbortError") return true;
    if (signal?.aborted === true) return true;
    return false;
}

function mergeSignals(
    a: AbortSignal,
    b: AbortSignal | undefined,
): AbortSignal {
    if (b === undefined) return a;
    if (typeof AbortSignal.any === "function") {
        return AbortSignal.any([a, b]);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (a.aborted || b.aborted) controller.abort();
    else {
        a.addEventListener("abort", onAbort, { once: true });
        b.addEventListener("abort", onAbort, { once: true });
    }
    return controller.signal;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
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
            const onAbort = () => {
                clearTimeout(timer);
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
            };
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });
}