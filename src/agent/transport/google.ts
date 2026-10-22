import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
    generateText,
    jsonSchema,
    streamText,
    type ModelMessage,
    type ToolSet,
} from "ai";
import type { ToolCall } from "../schemas.js";
import type {
    ChatMessage,
    LlmUsage,
    Transport,
    TransportResult,
} from "../llm.js";
import { TransportError } from "../llm.js";
import type { ToolDefinition } from "../tools/base.js";
import {
    THOUGHT_SIGNATURE_CAMEL_KEY,
    THOUGHT_SIGNATURE_KEY,
    decodeThoughtId,
    encodeThoughtId,
    extractThoughtSignature,
} from "../provider-options.js";

export interface GoogleTransportOptions {
    apiKey?: string;
    baseURL?: string;
}

type GenerateOptions = Parameters<typeof generateText>[0];
type ProviderOptions = NonNullable<GenerateOptions["providerOptions"]>;
type ProviderMetadataMap = Record<string, Record<string, unknown>>;
type JsonSchemaInput = Parameters<typeof jsonSchema>[0];

interface RawToolCall {
    toolCallId: string;
    toolName: string;
    args?: unknown;
    input?: unknown;
    providerMetadata?: Record<string, unknown>;
    providerOptions?: Record<string, unknown>;
}

function debugSig(message: string): void {
    if (process.env.TSAGENT_DEBUG_SIG === "1") {
        process.stderr.write(`[transport/sig] ${message}\n`);
    }
}

/**
 * Split system messages out of the `ChatMessage` array.
 *
 * `ai@6` warns when system content appears inside `messages` and
 * recommends the top-level `system` parameter instead.
 */
function splitSystemMessages(messages: ChatMessage[]): {
    system: string | undefined;
    rest: ChatMessage[];
} {
    const systemParts: string[] = [];
    const rest: ChatMessage[] = [];
    for (const msg of messages) {
        if (msg.role === "system") {
            systemParts.push(msg.content);
        } else {
            rest.push(msg);
        }
    }
    return {
        system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
        rest,
    };
}

/**
 * Live transport for the Google provider via the Vercel AI SDK (v6).
 */
export class GoogleTransport implements Transport {
    private readonly client: ReturnType<typeof createGoogleGenerativeAI>;
    private readonly model: string;

    constructor(model: string, options: GoogleTransportOptions = {}) {
        const apiKey =
            options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
        if (apiKey === undefined || apiKey === "") {
            throw new TransportError("missing GEMINI_API_KEY / GOOGLE_API_KEY", {
                statusCode: 401,
            });
        }
        this.client = createGoogleGenerativeAI({
            apiKey,
            ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
        });
        this.model = model;
    }

    async call(request: Parameters<Transport["call"]>[0]): Promise<TransportResult> {
        const { system, rest } = splitSystemMessages(request.messages);
        const messages = translateMessages(rest);
        const tools = request.tools !== undefined ? translateTools(request.tools) : undefined;
        const model = this.client(this.model);

        try {
            if (request.onTextDelta !== undefined) {
                return await this.callStreaming(request, system, messages, tools, model);
            }
            const result = await generateText({
                model,
                ...(system !== undefined ? { system } : {}),
                messages,
                ...(tools !== undefined ? { tools } : {}),
                ...(request.toolChoice !== undefined
                    ? { toolChoice: translateToolChoice(request.toolChoice) }
                    : {}),
                ...(request.providerOptions !== undefined
                    ? { providerOptions: toProviderOptions(request.providerOptions) }
                    : {}),
                ...(request.signal !== undefined ? { abortSignal: request.signal } : {}),
                maxRetries: 0,
            });
            return fromGenerateResult({
                text: result.text,
                toolCalls: result.toolCalls as unknown as RawToolCall[],
                usage: result.usage as unknown as RawUsage,
                providerMetadata: result.providerMetadata as ProviderMetadataMap | undefined,
                responseMessages: result.response?.messages,
            });
        } catch (error) {
            throw translateError(error);
        }
    }

    private async callStreaming(
        request: Parameters<Transport["call"]>[0],
        system: string | undefined,
        messages: ModelMessage[],
        tools: ToolSet | undefined,
        model: Parameters<typeof streamText>[0]["model"],
    ): Promise<TransportResult> {
        const onTextDelta = request.onTextDelta;
        if (onTextDelta === undefined) {
            throw new TransportError("streaming called without onTextDelta", {
                statusCode: 500,
            });
        }

        let capturedStreamError: unknown = null;

        const streamResult = streamText({
            model,
            ...(system !== undefined ? { system } : {}),
            messages,
            ...(tools !== undefined ? { tools } : {}),
            ...(request.toolChoice !== undefined
                ? { toolChoice: translateToolChoice(request.toolChoice) }
                : {}),
            ...(request.providerOptions !== undefined
                ? { providerOptions: toProviderOptions(request.providerOptions) }
                : {}),
            ...(request.signal !== undefined ? { abortSignal: request.signal } : {}),
            maxRetries: 0,
            onChunk: (event) => {
                if (event.chunk.type === "text-delta") {
                    onTextDelta(event.chunk.text);
                }
            },
            onError: (event: { error: unknown }) => {
                capturedStreamError = event.error;
            },
        });

        try {
            const [text, toolCalls, usage, providerMetadata, response] =
                await Promise.all([
                    streamResult.text,
                    streamResult.toolCalls,
                    streamResult.usage,
                    streamResult.providerMetadata,
                    streamResult.response,
                ]);

            return fromGenerateResult({
                text,
                toolCalls: toolCalls as unknown as RawToolCall[],
                usage: usage as unknown as RawUsage,
                providerMetadata: providerMetadata as ProviderMetadataMap | undefined,
                responseMessages: response.messages,
            });
        } catch (error) {
            await new Promise<void>((r) => setImmediate(r));
            if (capturedStreamError !== null) {
                throw translateError(capturedStreamError);
            }
            const errorsPromise = (streamResult as { errors?: unknown }).errors;
            if (
                errorsPromise !== null &&
                typeof errorsPromise === "object" &&
                typeof (errorsPromise as { then?: unknown }).then === "function"
            ) {
                try {
                    const rawErrors = await Promise.race([
                        errorsPromise as Promise<unknown[]>,
                        new Promise<unknown[]>((r) => setTimeout(() => r([]), 2000)),
                    ]);
                    if (Array.isArray(rawErrors) && rawErrors.length > 0) {
                        const raw = rawErrors[0];
                        if (raw !== undefined && raw !== null) {
                            throw translateError(raw);
                        }
                    }
                } catch (e) {
                    if (e instanceof TransportError) throw e;
                }
            }
            throw error;
        }
    }
}

// =========================================================================
// Message translation
// =========================================================================

function translateMessages(messages: ChatMessage[]): ModelMessage[] {
    const out: ModelMessage[] = [];

    for (const message of messages) {
        if (message.role === "system") {
            out.push({ role: "system", content: message.content });
            continue;
        }
        if (message.role === "user") {
            out.push({ role: "user", content: message.content });
            continue;
        }
        if (message.role === "assistant") {
            const parts: Array<
                | { type: "text"; text: string }
                | {
                    type: "tool-call";
                    toolCallId: string;
                    toolName: string;
                    input: Record<string, unknown>;
                    providerOptions?: { google: Record<string, unknown> };
                }
            > = [];
            if (message.content !== null && message.content !== "") {
                parts.push({ type: "text", text: message.content });
            }
            if (message.toolCalls !== undefined) {
                for (const toolCall of message.toolCalls) {
                    const part: {
                        type: "tool-call";
                        toolCallId: string;
                        toolName: string;
                        input: Record<string, unknown>;
                        providerOptions?: { google: Record<string, unknown> };
                    } = {
                        type: "tool-call",
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        input: toolCall.arguments,
                    };

                    const signature = extractThoughtSignature(toolCall.providerOptions ?? null);
                    if (signature !== null) {
                        part.providerOptions = {
                            google: { [THOUGHT_SIGNATURE_CAMEL_KEY]: signature },
                        };
                        debugSig(
                            `outbound tool-call ${toolCall.id} -> attached signature (len=${signature.length})`,
                        );
                    } else {
                        debugSig(
                            `outbound tool-call ${toolCall.id} -> NO SIGNATURE in providerOptions=${JSON.stringify(toolCall.providerOptions ?? null)}`,
                        );
                    }

                    parts.push(part);
                }
            }
            if (parts.length === 0) {
                parts.push({ type: "text", text: "" });
            }
            out.push({ role: "assistant", content: parts } as unknown as ModelMessage);
            continue;
        }
        out.push({
            role: "tool",
            content: [
                {
                    type: "tool-result",
                    toolCallId: message.toolCallId,
                    toolName: message.name,
                    output: { type: "text", value: message.content },
                },
            ],
        } as unknown as ModelMessage);
    }

    return out;
}

// =========================================================================
// Tool / toolChoice translation
// =========================================================================

function translateTools(definitions: ToolDefinition[]): ToolSet {
    const out: Record<
        string,
        { description: string; inputSchema: ReturnType<typeof jsonSchema> }
    > = {};
    for (const definition of definitions) {
        out[definition.function.name] = {
            description: definition.function.description,
            inputSchema: jsonSchema(
                definition.function.parameters as unknown as JsonSchemaInput,
            ),
        };
    }
    return out as unknown as ToolSet;
}

type OurToolChoice =
    | "auto"
    | "required"
    | "none"
    | { type: "function"; name: string };

function translateToolChoice(
    choice: OurToolChoice,
): "auto" | "required" | "none" | { type: "tool"; toolName: string } {
    if (typeof choice === "string") return choice;
    return { type: "tool", toolName: choice.name };
}

// =========================================================================
// Provider options
// =========================================================================

function toProviderOptions(googleOptions: Record<string, unknown>): ProviderOptions {
    return { google: googleOptions } as unknown as ProviderOptions;
}

// =========================================================================
// Result translation
// =========================================================================

interface RawUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
}

interface MappedToolCall {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
}

function mapRawToolCall(toolCall: RawToolCall): MappedToolCall {
    return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        args: (toolCall.args ?? toolCall.input ?? {}) as Record<string, unknown>,
    };
}

function normalizeUsage(raw: RawUsage): LlmUsage {
    const promptTokens = raw.inputTokens ?? raw.promptTokens ?? 0;
    const completionTokens = raw.outputTokens ?? raw.completionTokens ?? 0;
    const totalTokens = raw.totalTokens ?? promptTokens + completionTokens;
    return { promptTokens, completionTokens, totalTokens };
}

function extractGoogleSignature(
    meta: Record<string, unknown> | null | undefined,
): string | null {
    if (meta === null || meta === undefined) return null;
    const google = meta.google;
    if (google !== null && typeof google === "object" && !Array.isArray(google)) {
        const sig = extractThoughtSignature(google as Record<string, unknown>);
        if (sig !== null) return sig;
    }
    return extractThoughtSignature(meta);
}

function extractSignaturesFromToolCalls(
    toolCalls: RawToolCall[],
): Map<string, string> {
    const signatures = new Map<string, string>();
    for (const call of toolCalls) {
        if (signatures.has(call.toolCallId)) continue;
        const sig =
            extractGoogleSignature(call.providerMetadata) ??
            extractGoogleSignature(call.providerOptions);
        if (sig !== null) signatures.set(call.toolCallId, sig);
    }
    return signatures;
}

function extractSignaturesFromResponseMessages(
    messages: ModelMessage[] | undefined,
): Map<string, string> {
    const signatures = new Map<string, string>();
    if (messages === undefined) return signatures;

    for (const msg of messages) {
        if (msg.role !== "assistant") continue;
        if (!Array.isArray(msg.content)) continue;

        for (const rawPart of msg.content) {
            if (typeof rawPart !== "object" || rawPart === null) continue;
            const part = rawPart as Record<string, unknown>;
            if (part.type !== "tool-call") continue;

            const toolCallId = part.toolCallId;
            if (typeof toolCallId !== "string") continue;
            if (signatures.has(toolCallId)) continue;

            const meta = (part.providerMetadata ?? part.providerOptions) as
                | Record<string, unknown>
                | undefined;
            const sig = extractGoogleSignature(meta);
            if (sig !== null) signatures.set(toolCallId, sig);
        }
    }

    return signatures;
}

function mergeSignatureMaps(
    primary: Map<string, string>,
    secondary: Map<string, string>,
): Map<string, string> {
    const merged = new Map(primary);
    for (const [key, value] of secondary) {
        if (!merged.has(key)) merged.set(key, value);
    }
    return merged;
}

function fromGenerateResult(result: {
    text: string;
    toolCalls: RawToolCall[];
    usage: RawUsage;
    providerMetadata: ProviderMetadataMap | undefined;
    responseMessages: ModelMessage[] | undefined;
}): TransportResult {
    const globalGoogleMeta = result.providerMetadata?.google ?? {};

    const fromToolCalls = extractSignaturesFromToolCalls(result.toolCalls);
    const fromMessages = extractSignaturesFromResponseMessages(result.responseMessages);
    const signatureByCallId = mergeSignatureMaps(fromToolCalls, fromMessages);

    debugSig(
        `inbound call count=${result.toolCalls.length} ` +
        `extracted_from_toolCalls=${fromToolCalls.size} ` +
        `extracted_from_messages=${fromMessages.size} ` +
        `merged=${signatureByCallId.size} ` +
        `call_ids=${JSON.stringify(result.toolCalls.map((c) => c.toolCallId))}`,
    );

    const toolCalls: ToolCall[] = result.toolCalls.map((rawCall) => {
        const mapped = mapRawToolCall(rawCall);
        const decoded = decodeThoughtId(mapped.toolCallId);

        const signature =
            signatureByCallId.get(mapped.toolCallId) ??
            extractGoogleSignature(globalGoogleMeta);

        const toolCallOptions: Record<string, unknown> = {};
        if (signature !== null) {
            toolCallOptions[THOUGHT_SIGNATURE_KEY] = signature;
        }

        return {
            id:
                decoded !== null
                    ? encodeThoughtId(decoded.baseId, decoded.signature)
                    : mapped.toolCallId,
            name: mapped.toolName,
            arguments: mapped.args,
            providerOptions:
                Object.keys(toolCallOptions).length > 0 ? toolCallOptions : null,
        };
    });

    const providerOptions: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(globalGoogleMeta)) {
        providerOptions[key] = value;
    }

    return {
        text: result.text === "" ? null : result.text,
        toolCalls,
        usage: normalizeUsage(result.usage),
        providerOptions,
    };
}

// =========================================================================
// Error translation
// =========================================================================

/** Upper bound on the error message surfaced to `LlmResponse.errorMessage`. */
const MAX_ERROR_MESSAGE_LENGTH = 1000;

/** Upper bound on the total size of `providerData` after scrubbing. */
const MAX_PROVIDER_DATA_BYTES = 4096;

/**
 * Field names whose values must be redacted before an error is surfaced
 * or logged. Matches common credential-carrying keys that a provider or
 * proxy might echo back inside an error body.
 */
const SENSITIVE_KEY_PATTERN =
    /^(authorization|proxy-authorization|api[_-]?key|x-api-key|x-goog-api-key|token|access_token|id_token|refresh_token|secret|client_secret|password|bearer|session|session_id|cookie|set-cookie|private[_-]?key)$/i;

function truncateErrorMessage(text: string): string {
    if (text.length <= MAX_ERROR_MESSAGE_LENGTH) return text;
    return text.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1) + "…";
}

/**
 * Recursively redact sensitive fields from an arbitrary structured value.
 * Depth-limited to 8 to bound recursion on malformed or adversarial
 * payloads. Arrays are preserved element-by-element.
 */
function scrubSensitiveFields(value: unknown, depth = 0): unknown {
    if (depth > 8) return "[depth-limit]";
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
        return value.map((v) => scrubSensitiveFields(v, depth + 1));
    }
    if (typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (SENSITIVE_KEY_PATTERN.test(k)) {
                out[k] = "[redacted]";
            } else {
                out[k] = scrubSensitiveFields(v, depth + 1);
            }
        }
        return out;
    }
    return String(value);
}

/**
 * Bound the total serialized size of `providerData` after scrubbing. If
 * the payload is still too large, replace it with a marker so it cannot
 * bloat logs or cross wire boundaries.
 */
function boundProviderData(data: Record<string, unknown> | null): Record<string, unknown> | null {
    if (data === null) return null;
    let serialized: string;
    try {
        serialized = JSON.stringify(data);
    } catch {
        return { truncated: true, reason: "unserializable" };
    }
    if (serialized.length <= MAX_PROVIDER_DATA_BYTES) return data;
    return {
        truncated: true,
        originalBytes: serialized.length,
        preview: serialized.slice(0, 500),
    };
}

/**
 * Translate an SDK-thrown error into our `TransportError`.
 *
 * Sensitive data hygiene: provider error bodies occasionally echo request
 * metadata — including `Authorization` headers or API keys — inside
 * `error.details` or `error.metadata`. Those values must not reach the
 * user-visible error message, the structured `providerData`, or the
 * trace/log sink. Every string that passes through here is bounded and
 * scrubbed.
 *
 * Wrapping: `ai@6` sometimes wraps the real `APICallError` in a
 * `NoOutputGeneratedError` when a stream fails before emitting anything.
 * When that happens the surface message is useless and the real
 * status/body live on `.cause`; we reach into `cause` first.
 */
export function translateError(error: unknown): TransportError {
    if (error instanceof TransportError) return error;

    const candidate = error as {
        statusCode?: unknown;
        responseBody?: unknown;
        cause?: unknown;
        message?: string;
        data?: unknown;
    };
    const cause = candidate.cause as
        | {
            statusCode?: unknown;
            data?: unknown;
            message?: string;
            responseBody?: unknown;
        }
        | undefined;

    const status =
        typeof candidate.statusCode === "number"
            ? candidate.statusCode
            : typeof cause?.statusCode === "number"
                ? cause.statusCode
                : null;

    const rawMessage =
        typeof candidate.message === "string"
            ? candidate.message
            : typeof cause?.message === "string"
                ? cause.message
                : String(error);
    const message = truncateErrorMessage(rawMessage);

    let providerCode: string | null = null;
    let providerStatus: string | null = null;
    let providerData: Record<string, unknown> | null = null;
    let retryAfterMs: number | null = null;

    const body =
        candidate.responseBody ??
        candidate.data ??
        cause?.data ??
        cause?.responseBody ??
        candidate.cause;
    if (body !== null && typeof body === "object") {
        const err = (body as { error?: unknown }).error;
        if (err !== null && typeof err === "object") {
            const e = err as Record<string, unknown>;
            if (typeof e.code === "string") providerCode = e.code;
            if (typeof e.status === "string") providerStatus = e.status;

            // Scrub before storing. The result is what every downstream
            // consumer (CLI, tracing, verification) will see.
            const scrubbed = scrubSensitiveFields(e);
            providerData =
                scrubbed !== null && typeof scrubbed === "object" && !Array.isArray(scrubbed)
                    ? boundProviderData(scrubbed as Record<string, unknown>)
                    : null;

            // Direct retryDelay (OpenAI style, and some Google responses).
            const directRetry = e.retryDelay ?? e.retry_after;
            if (typeof directRetry === "string") {
                retryAfterMs = parseDuration(directRetry);
            } else if (typeof directRetry === "number") {
                retryAfterMs = directRetry;
            } else {
                // Google style: retryDelay is inside `details[]` under a
                // `type.googleapis.com/google.rpc.RetryInfo` entry.
                const details = e.details;
                if (Array.isArray(details)) {
                    for (const d of details) {
                        if (d === null || typeof d !== "object") continue;
                        const rd = (d as Record<string, unknown>).retryDelay;
                        if (typeof rd === "string") {
                            retryAfterMs = parseDuration(rd);
                            break;
                        } else if (typeof rd === "number") {
                            retryAfterMs = rd;
                            break;
                        }
                    }
                }
            }
        }
    }

    return new TransportError(message, {
        statusCode: status,
        providerStatus,
        providerCode,
        providerData,
        retryAfterMs,
    });
}

function parseDuration(value: string): number | null {
    const match = value.match(/^([\d.]+)\s*(ms|s)?$/i);
    if (match === null) return null;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;
    const unit = (match[2] ?? "s").toLowerCase();
    return unit === "ms" ? amount : amount * 1000;
}