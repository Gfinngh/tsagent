import { ZodError, z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
    ExecutionContext,
    type FinalResult,
} from "./context.js";
import type {
    LlmClientProtocol,
    LlmErrorMetadata,
    LlmRequest,
    LlmUsage,
} from "./llm.js";
import { PromptCache } from "./prompt-cache.js";
import {
    makeEvent,
    messageContentItem,
    toolCallContentItem,
    toolResultContentItem,
    type AgentEvent,
    type ContentItem,
    type ToolCall,
    type ToolErrorKind,
    type ToolResult,
} from "./schemas.js";
import { isAbortError, makeAbortError, mergeSignals } from "./signals.js";
import {
    ToolError,
    type BaseTool,
    type ToolDefinition,
} from "./tools/base.js";
import { withSpan } from "./tracing.js";

// =========================================================================
// Errors
// =========================================================================

export class LlmCallError extends Error {
    readonly metadata: LlmErrorMetadata;
    constructor(message: string, metadata: LlmErrorMetadata) {
        super(message);
        this.name = "LlmCallError";
        this.metadata = metadata;
    }
}

export class AgentTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(message: string, timeoutMs: number) {
        super(message);
        this.name = "AgentTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}

export class CancelledError extends Error {
    constructor(message = "cancelled", options?: { cause?: unknown }) {
        super(message, options);
        this.name = "CancelledError";
    }
}

class ToolTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number) {
        super(`tool timed out after ${timeoutMs}ms`);
        this.name = "ToolTimeoutError";
        this.timeoutMs = timeoutMs;
    }
}

// =========================================================================
// Public types
// =========================================================================

export interface AgentOptions {
    llmClient: LlmClientProtocol;
    tools?: BaseTool[];
    instructions?: string[];
    maxSteps?: number;
    outputType?: z.ZodTypeAny;
    allowDangerous?: boolean;
    confirmToolCall?: (toolCall: ToolCall, tool: BaseTool) => boolean | Promise<boolean>;
    runTimeoutMs?: number | null;
}

export interface AgentRunOptions {
    signal?: AbortSignal;
    /** Fires after every event is appended to the context. */
    onEvent?: (event: AgentEvent) => void;
}

export interface AgentResumeOptions {
    userMessage?: string;
    signal?: AbortSignal;
    /** Fires after every event is appended to the context. */
    onEvent?: (event: AgentEvent) => void;
}

export interface AgentResult {
    context: ExecutionContext;
    finalResult: FinalResult | null;
    stoppedByMaxSteps: boolean;
    usage: LlmUsage | null;
}

const DEFAULT_MAX_STEPS = 10;
const FINAL_ANSWER_TOOL_NAME = "final_answer";
const FINAL_ANSWER_DESCRIPTION =
    "Return the final structured answer. Provide the `output` field matching the expected schema.";

// =========================================================================
// Resume-state detection (exported for verification)
// =========================================================================

export type ResumeState = "complete" | "pendingTool" | "pendingFinal";

export function detectResumeState(context: ExecutionContext): ResumeState {
    if (context.finalResult !== null) return "complete";
    const pending = findPendingToolCalls(context.events);
    if (pending.length > 0) return "pendingTool";
    return "pendingFinal";
}

export function findPendingToolCalls(events: AgentEvent[]): ToolCall[] {
    const resolved = new Set<string>();
    for (const event of events) {
        for (const item of event.content) {
            if (item.type === "tool_result") resolved.add(item.toolResult.toolCallId);
        }
    }
    const pending: ToolCall[] = [];
    for (const event of events) {
        for (const item of event.content) {
            if (item.type === "tool_call" && !resolved.has(item.toolCall.id)) {
                pending.push(item.toolCall);
            }
        }
    }
    return pending;
}

// =========================================================================
// Agent
// =========================================================================

export class Agent {
    readonly llmClient: LlmClientProtocol;
    readonly instructions: string[];
    readonly maxSteps: number;
    readonly outputType: z.ZodTypeAny | undefined;
    readonly allowDangerous: boolean;
    readonly runTimeoutMs: number | null;
    private readonly confirmToolCall:
        | ((toolCall: ToolCall, tool: BaseTool) => boolean | Promise<boolean>)
        | null;
    private readonly tools: Map<string, BaseTool>;
    private readonly toolDefinitions: ToolDefinition[];

    constructor(options: AgentOptions) {
        this.llmClient = options.llmClient;
        this.instructions = options.instructions ?? [];
        this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
        this.outputType = options.outputType;
        this.allowDangerous = options.allowDangerous ?? false;
        this.runTimeoutMs = options.runTimeoutMs ?? null;
        this.confirmToolCall = options.confirmToolCall ?? null;

        this.tools = new Map();
        for (const tool of options.tools ?? []) {
            if (this.tools.has(tool.name)) {
                throw new Error(`duplicate tool name: ${tool.name}`);
            }
            this.tools.set(tool.name, tool);
        }

        this.toolDefinitions = [];
        for (const tool of this.tools.values()) {
            this.toolDefinitions.push(tool.toolDefinition());
        }
        if (this.outputType !== undefined) {
            this.toolDefinitions.push(buildFinalAnswerDefinition(this.outputType));
        }
    }

    async run(userMessage: string, options: AgentRunOptions = {}): Promise<AgentResult> {
        return withSpan(
            "agent.run",
            async (rootSpan) => {
                rootSpan.setAttribute("agent.max_steps", this.maxSteps);
                rootSpan.setAttribute("agent.allow_dangerous", this.allowDangerous);
                rootSpan.setAttribute("agent.structured", this.outputType !== undefined);
                rootSpan.setAttribute("agent.user_message_length", userMessage.length);

                const context = new ExecutionContext(
                    [],
                    this.outputType !== undefined ? FINAL_ANSWER_TOOL_NAME : null,
                );
                const result = await this.executeWithTimeout(options.signal, (runSignal) =>
                    this.runLoop(context, userMessage, runSignal, options.onEvent),
                );
                rootSpan.setAttribute(
                    "agent.final_result_kind",
                    result.finalResult?.kind ?? "null",
                );
                rootSpan.setAttribute("agent.current_step", result.context.currentStep);
                return result;
            },
        );
    }

    async resume(
        context: ExecutionContext,
        options: AgentResumeOptions = {},
    ): Promise<AgentResult> {
        const state = detectResumeState(context);
        return withSpan(
            "agent.resume",
            async (rootSpan) => {
                rootSpan.setAttribute("agent.max_steps", this.maxSteps);
                rootSpan.setAttribute("agent.structured", this.outputType !== undefined);
                rootSpan.setAttribute("agent.resume_state", state);

                const result = await this.executeWithTimeout(options.signal, (runSignal) =>
                    this.resumeLoop(
                        context,
                        options.userMessage ?? null,
                        runSignal,
                        options.onEvent,
                    ),
                );
                rootSpan.setAttribute(
                    "agent.final_result_kind",
                    result.finalResult?.kind ?? "null",
                );
                return result;
            },
        );
    }

    // -----------------------------------------------------------------------
    // Timeout wrapper
    // -----------------------------------------------------------------------

    private async executeWithTimeout<T>(
        callerSignal: AbortSignal | undefined,
        body: (runSignal: AbortSignal) => Promise<T>,
    ): Promise<T> {
        const runController = new AbortController();
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        if (this.runTimeoutMs !== null) {
            const ms = this.runTimeoutMs;
            timeoutHandle = setTimeout(() => {
                runController.abort(
                    new AgentTimeoutError(`agent timed out after ${ms}ms`, ms),
                );
            }, ms);
        }
        const runSignal =
            callerSignal !== undefined
                ? mergeSignals(runController.signal, callerSignal)
                : runController.signal;

        try {
            return await body(runSignal);
        } catch (error) {
            if (callerSignal?.aborted === true) {
                throw new CancelledError("agent cancelled", { cause: error });
            }
            if (isAbortError(error) && runSignal.reason instanceof AgentTimeoutError) {
                throw runSignal.reason;
            }
            throw error;
        } finally {
            if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        }
    }

    // -----------------------------------------------------------------------
    // Resume state machine
    // -----------------------------------------------------------------------

    private async resumeLoop(
        context: ExecutionContext,
        userMessage: string | null,
        runSignal: AbortSignal,
        onEvent?: (event: AgentEvent) => void,
    ): Promise<AgentResult> {
        if (context.events.length === 0) {
            throw new Error("cannot resume from an empty execution context");
        }

        const state = detectResumeState(context);

        if (state === "complete") {
            if (userMessage === null) {
                return {
                    context,
                    finalResult: context.finalResult,
                    stoppedByMaxSteps: false,
                    usage: null,
                };
            }
            return this.runLoop(context, userMessage, runSignal, onEvent);
        }

        if (state === "pendingTool") {
            if (userMessage !== null) {
                throw new Error(
                    "cannot supply a follow-up user message while tool calls are pending",
                );
            }
            const pending = findPendingToolCalls(context.events);
            const results = await this.executeToolCalls(pending, runSignal);
            emitEvent(
                context,
                makeEvent(results.map((result) => toolResultContentItem(result))),
                onEvent,
            );
            return this.runLoop(context, null, runSignal, onEvent);
        }

        // state === "pendingFinal"
        return this.runLoop(context, userMessage, runSignal, onEvent);
    }

    // -----------------------------------------------------------------------
    // Main loop
    // -----------------------------------------------------------------------

    private async runLoop(
        context: ExecutionContext,
        userMessage: string | null,
        runSignal: AbortSignal,
        onEvent?: (event: AgentEvent) => void,
    ): Promise<AgentResult> {
        if (userMessage !== null) {
            emitEvent(
                context,
                makeEvent([messageContentItem({ role: "user", content: userMessage })]),
                onEvent,
            );
        }

        // Incremental prompt builder. `buildMessages` would re-serialize
        // every prior tool result on every step; the cache avoids that by
        // extending in place. Correctness invariant:
        // `promptCache.build(events)` is structurally identical to
        // `buildMessages(instructions, events)`.
        const promptCache = new PromptCache(this.instructions);

        let usage: LlmUsage | null = null;

        while (context.currentStep < this.maxSteps && context.finalResult === null) {
            if (runSignal.aborted) throw makeAbortError();

            const stepIndex = context.currentStep;
            const shouldStop = await withSpan(
                "agent.step",
                async (stepSpan) => {
                    stepSpan.setAttribute("agent.step_index", stepIndex);

                    let toolChoice: LlmRequest["toolChoice"] | undefined;
                    if (this.outputType !== undefined) {
                        toolChoice = "required";
                    } else if (this.toolDefinitions.length > 0) {
                        toolChoice = "auto";
                    }

                    const request: LlmRequest = {
                        instructions: this.instructions,
                        events: [...context.events],
                        prebuiltMessages: promptCache.build(context.events),
                        signal: runSignal,
                    };
                    if (this.toolDefinitions.length > 0) request.tools = this.toolDefinitions;
                    if (toolChoice !== undefined) request.toolChoice = toolChoice;

                    const response = await this.llmClient.generate(request);

                    if (response.errorMessage !== null) {
                        throw new LlmCallError(response.errorMessage, response.errorMetadata);
                    }
                    if (response.usage !== null) usage = response.usage;

                    const content: ContentItem[] = [];
                    if (response.text !== null) {
                        content.push(
                            messageContentItem({ role: "assistant", content: response.text }),
                        );
                    } else if (response.toolCalls.length > 0) {
                        content.push(messageContentItem({ role: "assistant", content: null }));
                    }
                    for (const toolCall of response.toolCalls) {
                        content.push(toolCallContentItem(toolCall));
                    }

                    if (content.length === 0) {
                        stepSpan.setStatus("error", "empty LLM response");
                        return true;
                    }

                    stepSpan.setAttribute("agent.step.tool_calls_count", response.toolCalls.length);
                    emitEvent(context, makeEvent(content), onEvent);

                    if (response.toolCalls.length > 0) {
                        const results = await this.executeToolCalls(response.toolCalls, runSignal);
                        emitEvent(
                            context,
                            makeEvent(results.map((result) => toolResultContentItem(result))),
                            onEvent,
                        );
                    }

                    return false;
                },
            );

            if (shouldStop) break;
        }

        const stoppedByMaxSteps =
            context.finalResult === null && context.currentStep >= this.maxSteps;

        return {
            context,
            finalResult: context.finalResult,
            stoppedByMaxSteps,
            usage,
        };
    }

    // -----------------------------------------------------------------------
    // Tool execution: phases 1 (resolve + permissions) → 2 (execute) → 3 (order)
    // -----------------------------------------------------------------------

    private async executeToolCalls(
        toolCalls: ToolCall[],
        runSignal: AbortSignal,
    ): Promise<ToolResult[]> {
        type Prepared =
            | { kind: "execute"; toolCall: ToolCall; tool: BaseTool }
            | { kind: "result"; result: ToolResult };

        const prepared: Prepared[] = [];

        for (const toolCall of toolCalls) {
            if (
                this.outputType !== undefined &&
                toolCall.name === FINAL_ANSWER_TOOL_NAME
            ) {
                prepared.push({ kind: "result", result: this.finalAnswerResult(toolCall) });
                continue;
            }

            const tool = this.tools.get(toolCall.name);
            if (tool === undefined) {
                prepared.push({
                    kind: "result",
                    result: this.errorResult(
                        toolCall,
                        `tool "${toolCall.name}" not found`,
                        "domain",
                    ),
                });
                continue;
            }

            const permission = await this.checkPermission(toolCall, tool);
            if (!permission.allowed) {
                prepared.push({
                    kind: "result",
                    result: this.errorResult(toolCall, permission.reason, "denied"),
                });
                continue;
            }

            prepared.push({ kind: "execute", toolCall, tool });
        }

        const toExecute = prepared.filter(
            (p): p is { kind: "execute"; toolCall: ToolCall; tool: BaseTool } =>
                p.kind === "execute",
        );

        const allSafe = toExecute.every((p) => p.tool.concurrencySafe);

        let executed: ToolResult[];
        if (allSafe && toExecute.length > 1) {
            const settled = await Promise.allSettled(
                toExecute.map((p) => this.executeOne(p.toolCall, p.tool, runSignal)),
            );
            if (runSignal.aborted) {
                for (const s of settled) {
                    if (s.status === "rejected" && isAbortError(s.reason)) throw s.reason;
                }
                throw makeAbortError();
            }
            executed = settled.map((s, i) => {
                if (s.status === "fulfilled") return s.value;
                const entry = toExecute[i]!;
                const message =
                    s.reason instanceof Error ? s.reason.message : String(s.reason);
                return this.errorResult(entry.toolCall, message, "exception");
            });
        } else {
            executed = [];
            for (const p of toExecute) {
                executed.push(await this.executeOne(p.toolCall, p.tool, runSignal));
            }
        }

        const executedByCallId = new Map(
            executed.map((r) => [r.toolCallId, r] as const),
        );
        const ordered: ToolResult[] = [];
        for (const entry of prepared) {
            if (entry.kind === "result") {
                ordered.push(entry.result);
                continue;
            }
            const result = executedByCallId.get(entry.toolCall.id);
            if (result !== undefined) ordered.push(result);
        }
        return ordered;
    }

    // -----------------------------------------------------------------------
    // One tool call (instrumented with `agent.tool` span)
    // -----------------------------------------------------------------------

    private async executeOne(
        toolCall: ToolCall,
        tool: BaseTool,
        runSignal: AbortSignal,
    ): Promise<ToolResult> {
        return withSpan(
            "agent.tool",
            async (toolSpan) => {
                toolSpan.setAttribute("agent.tool.name", tool.name);
                toolSpan.setAttribute("agent.tool.permission", tool.permission);
                toolSpan.setAttribute("agent.tool.call_id", toolCall.id);

                const toolController = new AbortController();
                const toolSignal =
                    typeof AbortSignal.any === "function"
                        ? AbortSignal.any([toolController.signal, runSignal])
                        : mergeSignals(toolController.signal, runSignal);

                let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
                let onRunAbort: (() => void) | null = null;

                try {
                    if (runSignal.aborted) throw makeAbortError();

                    const toolPromise = tool.run(toolCall.arguments, toolSignal);
                    const races: Array<Promise<unknown[]>> = [toolPromise];

                    if (tool.timeoutMs !== null) {
                        const ms = tool.timeoutMs;
                        races.push(
                            new Promise<unknown[]>((_resolve, reject) => {
                                timeoutHandle = setTimeout(() => {
                                    toolController.abort(new ToolTimeoutError(ms));
                                    reject(new ToolTimeoutError(ms));
                                }, ms);
                            }),
                        );
                    }

                    races.push(
                        new Promise<unknown[]>((_resolve, reject) => {
                            onRunAbort = () => reject(makeAbortError());
                            runSignal.addEventListener("abort", onRunAbort, { once: true });
                        }),
                    );

                    const content = await Promise.race(races);
                    return {
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        content,
                        status: "success",
                        errorKind: null,
                    };
                } catch (error) {
                    if (isAbortError(error) && runSignal.aborted) {
                        toolSpan.setStatus("error", "cancelled");
                        throw error;
                    }
                    if (
                        error instanceof ToolTimeoutError ||
                        toolSignal.reason instanceof ToolTimeoutError
                    ) {
                        const ms = tool.timeoutMs ?? 0;
                        const message = `tool "${tool.name}" timed out after ${ms}ms`;
                        toolSpan.setStatus("error", message);
                        return this.errorResult(toolCall, message, "timeout");
                    }
                    const message = error instanceof Error ? error.message : String(error);
                    toolSpan.setStatus("error", message);
                    // `McpToolError extends ToolError`, so domain covers both.
                    const kind: ToolErrorKind =
                        error instanceof ToolError || error instanceof ZodError
                            ? "domain"
                            : "exception";
                    return this.errorResult(toolCall, message, kind);
                } finally {
                    if (timeoutHandle !== null) clearTimeout(timeoutHandle);
                    if (onRunAbort !== null) runSignal.removeEventListener("abort", onRunAbort);
                }
            },
        );
    }

    // -----------------------------------------------------------------------
    // Permissions
    // -----------------------------------------------------------------------

    private async checkPermission(
        toolCall: ToolCall,
        tool: BaseTool,
    ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
        if (tool.permission === "read") return { allowed: true };

        if (tool.permission === "mutate") {
            if (this.confirmToolCall === null) {
                return {
                    allowed: false,
                    reason: `tool "${tool.name}" requires confirmation but no confirmation callback was provided`,
                };
            }
            return this.invokeConfirmation(toolCall, tool, false);
        }

        // dangerous
        if (!this.allowDangerous) {
            return {
                allowed: false,
                reason: `tool "${tool.name}" is dangerous and allowDangerous is false`,
            };
        }
        if (this.confirmToolCall === null) {
            return {
                allowed: false,
                reason: `dangerous tool "${tool.name}" requires confirmation but no confirmation callback was provided`,
            };
        }
        return this.invokeConfirmation(toolCall, tool, true);
    }

    private async invokeConfirmation(
        toolCall: ToolCall,
        tool: BaseTool,
        dangerous: boolean,
    ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
        const label = dangerous
            ? `dangerous tool "${tool.name}"`
            : `tool "${tool.name}"`;
        try {
            const approved = await this.confirmToolCall!(toolCall, tool);
            if (approved) return { allowed: true };
            return { allowed: false, reason: `${label} was not approved` };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                allowed: false,
                reason: `confirmation callback failed for ${label}: ${message}`,
            };
        }
    }

    // -----------------------------------------------------------------------
    // final_answer + helpers
    // -----------------------------------------------------------------------

    private finalAnswerResult(toolCall: ToolCall): ToolResult {
        const outputType = this.outputType;
        if (outputType === undefined) {
            return this.errorResult(
                toolCall,
                "final_answer called without outputType",
                "exception",
            );
        }
        const schema = z.object({ output: outputType });
        const parsed = schema.safeParse(toolCall.arguments);
        if (parsed.success) {
            return {
                toolCallId: toolCall.id,
                name: FINAL_ANSWER_TOOL_NAME,
                content: [parsed.data],
                status: "success",
                errorKind: null,
            };
        }
        return this.errorResult(
            toolCall,
            `invalid final_answer arguments: ${parsed.error.message}`,
            "domain",
        );
    }

    private errorResult(
        toolCall: ToolCall,
        message: string,
        kind: ToolErrorKind,
    ): ToolResult {
        return {
            toolCallId: toolCall.id,
            name: toolCall.name,
            content: [message],
            status: "error",
            errorKind: kind,
        };
    }
}

// =========================================================================
// Helpers
// =========================================================================

function emitEvent(
    context: ExecutionContext,
    event: AgentEvent,
    onEvent: ((event: AgentEvent) => void) | undefined,
): void {
    context.addEvent(event);
    if (onEvent !== undefined) onEvent(event);
}

function buildFinalAnswerDefinition(outputType: z.ZodTypeAny): ToolDefinition {
    const raw = zodToJsonSchema(z.object({ output: outputType }), {
        target: "openAi",
        $refStrategy: "none",
    }) as Record<string, unknown>;
    const { $schema: _schema, title: _title, ...parameters } = raw;
    return {
        type: "function",
        function: {
            name: FINAL_ANSWER_TOOL_NAME,
            description: FINAL_ANSWER_DESCRIPTION,
            parameters,
        },
    };
}

// Re-exported for backward compatibility.
export { makeEvent, messageContentItem, toolCallContentItem, toolResultContentItem };
export type { AgentEvent };