import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Permission tiers form a two-lock model in the agent:
 *   - `read`: no callback required, always allowed
 *   - `mutate`: requires a `confirmToolCall` callback
 *   - `dangerous`: requires both `allowDangerous` AND a callback returning true
 */
export type PermissionTier = "read" | "mutate" | "dangerous";

const PERMISSION_TIERS: readonly PermissionTier[] = ["read", "mutate", "dangerous"];

export function isPermissionTier(value: unknown): value is PermissionTier {
    return (
        typeof value === "string" &&
        (PERMISSION_TIERS as readonly string[]).includes(value)
    );
}

/** Raised by tool implementations to produce an error `ToolResult`. */
export class ToolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ToolError";
    }
}

export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

export interface BaseToolOptions {
    name: string;
    description: string;
    permission?: PermissionTier;
    concurrencySafe?: boolean;
    timeoutMs?: number | null;
}

/**
 * Abstract base for every tool. Concrete subclasses are `FunctionTool`
 * (wraps a typed async function) and `RemoteTool` (wraps an MCP server
 * callback with a raw input schema).
 */
export abstract class BaseTool {
    readonly name: string;
    readonly description: string;
    readonly permission: PermissionTier;
    readonly concurrencySafe: boolean;
    readonly timeoutMs: number | null;

    protected constructor(options: BaseToolOptions) {
        if (!options.name) throw new ToolError("tool name is required");
        if (typeof options.description !== "string") {
            throw new ToolError("tool description is required");
        }
        const permission = options.permission ?? "read";
        if (!isPermissionTier(permission)) {
            throw new ToolError(`invalid permission tier: ${String(permission)}`);
        }
        if (options.timeoutMs !== undefined && options.timeoutMs !== null) {
            if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
                throw new ToolError(`invalid timeoutMs: ${String(options.timeoutMs)}`);
            }
        }
        this.name = options.name;
        this.description = options.description;
        this.permission = permission;
        // Read tools are concurrency-safe by default; mutate/dangerous are not.
        this.concurrencySafe = options.concurrencySafe ?? permission === "read";
        this.timeoutMs = options.timeoutMs ?? null;
    }

    abstract toolDefinition(): ToolDefinition;

    abstract run(
        arguments_: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<unknown[]>;
}

export interface FunctionToolOptions<T extends z.ZodTypeAny = z.ZodTypeAny>
    extends BaseToolOptions {
    argsSchema: T;
    fn: (
        args: z.infer<T>,
        signal?: AbortSignal,
    ) => unknown | Promise<unknown>;
}

/**
 * A tool backed by a typed async function.
 *
 * - Arguments are validated against `argsSchema`.
 * - `$schema` and top-level `title` are stripped from the generated JSON
 *   schema, because OpenAI-style function calling rejects them.
 * - A single return value is wrapped in `[value]`; array returns are
 *   preserved as-is.
 * - The optional `signal` parameter lets the tool honor cancellation.
 */
export class FunctionTool<T extends z.ZodTypeAny = z.ZodTypeAny> extends BaseTool {
    readonly argsSchema: T;
    private readonly fn: (
        args: z.infer<T>,
        signal?: AbortSignal,
    ) => unknown | Promise<unknown>;

    constructor(options: FunctionToolOptions<T>) {
        super(options);
        this.argsSchema = options.argsSchema;
        this.fn = options.fn;
    }

    toolDefinition(): ToolDefinition {
        const raw = zodToJsonSchema(this.argsSchema, {
            target: "openAi",
            $refStrategy: "none",
        }) as Record<string, unknown>;
        const { $schema: _schema, title: _title, ...parameters } = raw;
        return {
            type: "function",
            function: {
                name: this.name,
                description: this.description,
                parameters,
            },
        };
    }

    async run(
        arguments_: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<unknown[]> {
        const validated = this.argsSchema.parse(arguments_);
        const result = await this.fn(validated, signal);
        if (Array.isArray(result)) return result;
        return [result];
    }
}

export interface RemoteToolOptions extends BaseToolOptions {
    inputSchema: Record<string, unknown>;
    callTool: (
        args: Record<string, unknown>,
        signal?: AbortSignal,
    ) => Promise<unknown[]>;
}

/**
 * A tool backed by an MCP server callback. The raw `inputSchema` returned
 * by the MCP server is used verbatim — no zod schema, no validation
 * rewriting — so that the tool definition matches what the server
 * advertised.
 */
export class RemoteTool extends BaseTool {
    readonly inputSchema: Record<string, unknown>;
    private readonly callTool: (
        args: Record<string, unknown>,
        signal?: AbortSignal,
    ) => Promise<unknown[]>;

    constructor(options: RemoteToolOptions) {
        super(options);
        this.inputSchema = options.inputSchema;
        this.callTool = options.callTool;
    }

    toolDefinition(): ToolDefinition {
        return {
            type: "function",
            function: {
                name: this.name,
                description: this.description,
                parameters: this.inputSchema,
            },
        };
    }

    async run(
        arguments_: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<unknown[]> {
        return this.callTool(arguments_, signal);
    }
}