import { randomUUID } from "node:crypto";
import { z } from "zod";

// =========================================================================
// Core schemas
// =========================================================================

/**
 * Message role. Only `system`, `user`, and `assistant` appear in the
 * event log; tool-result messages are built at prompt time by the LLM
 * client (`ChatMessage.role: "tool"`) and never persisted as events.
 */
export const MessageRoleSchema = z.enum(["system", "user", "assistant"]);

export const ToolCallSchema = z.object({
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    providerOptions: z.record(z.string(), z.unknown()).nullable().default(null),
});

/**
 * Tool error taxonomy.
 *
 * - `domain`    — the model supplied bad input that the tool (or its
 *                 schema) rejected: `ToolError`, `ZodError`, unknown
 *                 tool name, invalid `final_answer` arguments.
 * - `exception` — an unexpected throw from a tool implementation. Not a
 *                 domain validation failure; likely a bug.
 * - `denied`    — the two-lock permission model prevented execution.
 *                 Includes confirmation-callback exceptions (the tool
 *                 never ran).
 * - `timeout`   — a per-tool `timeoutMs` elapsed.
 *
 * `null` on success.
 */
export const ToolErrorKindSchema = z.enum([
    "domain",
    "exception",
    "denied",
    "timeout",
]);

export const ToolResultSchema = z.object({
    toolCallId: z.string(),
    name: z.string(),
    content: z.array(z.unknown()),
    status: z.enum(["success", "error"]),
    errorKind: ToolErrorKindSchema.nullable().default(null),
});

export const MessageSchema = z.object({
    role: MessageRoleSchema,
    content: z.string().nullable().default(null),
    toolCalls: z.array(ToolCallSchema).default([]),
    providerOptions: z.record(z.string(), z.unknown()).default({}),
});

/** Discriminated union on `type` — one of `message`, `tool_call`, `tool_result`. */
export const ContentItemSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("message"), message: MessageSchema }),
    z.object({ type: z.literal("tool_call"), toolCall: ToolCallSchema }),
    z.object({ type: z.literal("tool_result"), toolResult: ToolResultSchema }),
]);

export const AgentEventSchema = z.object({
    id: z.string(),
    timestamp: z.number(),
    content: z.array(ContentItemSchema),
});

// =========================================================================
// Multipart content
// =========================================================================

export const TextPartSchema = z.object({
    type: z.literal("text"),
    text: z.string(),
});

export const ImagePartSchema = z.object({
    type: z.literal("image"),
    mimeType: z.string(),
    data: z.string(),
});

export const ResourcePartSchema = z.object({
    type: z.literal("resource"),
    uri: z.string(),
    mimeType: z.string().nullable().default(null),
    text: z.string().nullable().default(null),
    blob: z.string().nullable().default(null),
});

export const StructuredPartSchema = z.object({
    type: z.literal("structured"),
    data: z.unknown(),
});

export const MultipartPartSchema = z.discriminatedUnion("type", [
    TextPartSchema,
    ImagePartSchema,
    ResourcePartSchema,
    StructuredPartSchema,
]);

export const MultipartContentSchema = z.object({
    type: z.literal("multipart"),
    parts: z.array(MultipartPartSchema),
});

// =========================================================================
// Inferred types
// =========================================================================

export type MessageRole = z.infer<typeof MessageRoleSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolErrorKind = z.infer<typeof ToolErrorKindSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ContentItem = z.infer<typeof ContentItemSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type MultipartPart = z.infer<typeof MultipartPartSchema>;
export type MultipartContent = z.infer<typeof MultipartContentSchema>;

// =========================================================================
// Constructors
// =========================================================================

/** Build a fresh `AgentEvent` with a uuid4 id and epoch-seconds timestamp. */
export function makeEvent(content: ContentItem[]): AgentEvent {
    return {
        id: randomUUID(),
        timestamp: Date.now() / 1000,
        content,
    };
}

export function messageContentItem(
    message: z.input<typeof MessageSchema>,
): ContentItem {
    return { type: "message", message: MessageSchema.parse(message) };
}

export function toolCallContentItem(
    toolCall: z.input<typeof ToolCallSchema>,
): ContentItem {
    return { type: "tool_call", toolCall: ToolCallSchema.parse(toolCall) };
}

export function toolResultContentItem(
    toolResult: z.input<typeof ToolResultSchema>,
): ContentItem {
    return { type: "tool_result", toolResult: ToolResultSchema.parse(toolResult) };
}