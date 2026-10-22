import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
    CallToolResultSchema,
    type CallToolResult,
    type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { MultipartPart } from "./schemas.js";
import {
    RemoteTool,
    ToolError,
    type PermissionTier,
} from "./tools/base.js";
import {
    imagePart,
    multipart,
    resourcePart,
    structuredPart,
    textPart,
} from "./tools/multipart.js";

// =========================================================================
// Public types
// =========================================================================

export interface McpServerParams {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    /** Deadline for the initial connect handshake. Default 10_000 ms. */
    connectTimeoutMs?: number;
    /**
     * Whether this server is trusted to accurately report
     * `_meta.permission` on its tools. Defaults to `true`.
     *
     * - `true`  — used for servers we spawn ourselves
     *   (`node --import tsx src/agent/server.ts`). The server's
     *   `_meta.permission` is honored; explicit `ToolOverrides` still
     *   win.
     * - `false` — used when the server command comes from an external
     *   source like `MCP_SERVER_COMMAND`. The server's
     *   `_meta.permission` is ignored; any tool without an explicit
     *   `ToolOverrides.permission` defaults to `"dangerous"`.
     *
     * `spawnMcpConnection` in `runtime.ts` sets this to `!isOverridden`
     * based on whether `MCP_SERVER_COMMAND` was present.
     */
    trusted?: boolean;
}

export interface ToolOverrides {
    permission?: PermissionTier;
    concurrencySafe?: boolean;
    timeoutMs?: number | null;
    description?: string;
}

/**
 * Thrown by `mcpResultToMultipart` when an MCP call returns `isError:
 * true`. Extends `ToolError` so that `Agent` classifies it as a domain
 * error (via `instanceof ToolError`).
 */
export class McpToolError extends ToolError {
    readonly toolName: string;
    constructor(message: string, toolName: string) {
        super(message);
        this.name = "McpToolError";
        this.toolName = toolName;
    }
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const SDK_ERROR_PREFIX = /^Error executing tool [^:]+:\s*/;

/**
 * Heuristic: does this error indicate that the child process / pipe is
 * dead, rather than a legitimate tool failure? Only matches specific
 * "transport is gone" patterns; deliberately conservative so that an
 * application-level error (returned as `CallToolResult.isError`, which
 * does not throw) cannot trigger a reconnect. `isError: true` flows
 * through `callTool` as a successful return; only genuine transport
 * exceptions reach this matcher.
 *
 * Exported so it can be unit-tested without a live subprocess.
 */
export function isClosedPipeError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message.toLowerCase();
    return (
        msg.includes("epipe") ||
        msg.includes("econnreset") ||
        msg.includes("write after end") ||
        msg.includes("not connected") ||
        msg.includes("transport closed") ||
        msg.includes("transport is closed") ||
        msg.includes("server process exited") ||
        msg.includes("process exited") ||
        msg.includes("connection closed") ||
        msg.includes("connection lost")
    );
}

// =========================================================================
// McpConnection
// =========================================================================

/**
 * Owns the stdio subprocess and the SDK client session. `connect()` is
 * lazy-idempotent; `close()` is safe to call from any state. Usable as an
 * `await using` resource.
 *
 * Resilience: `callTool` detects a dead-pipe error (subprocess crashed,
 * transport closed) and makes **one** reconnect attempt within a single
 * invocation. The failure burst is bounded: if the reconnect also fails,
 * the call fails. Successful calls reset the budget, so a long session
 * that loses its pipe once is not left permanently degraded.
 *
 * Retry safety: retrying the failed tool call is only safe because
 * every currently registered tool is either pure or idempotent-overwrite
 * (`write_file` overwrites the same path with the same content). A future
 * non-idempotent tool (e.g. `append_file`) would need to opt out — add a
 * `retrySafe: boolean` flag to `BaseTool` when the need arises. Until
 * then, this comment is the marker.
 */
export class McpConnection {
    readonly serverName: string;
    /**
     * Whether the server is trusted to accurately report
     * `_meta.permission`. See `McpServerParams.trusted`.
     */
    readonly trusted: boolean;
    private readonly params: McpServerParams;
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private connected = false;

    constructor(serverName: string, params: McpServerParams) {
        this.serverName = serverName;
        this.params = params;
        this.trusted = params.trusted ?? true;
    }

    get isConnected(): boolean {
        return this.connected;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        const timeoutMs =
            this.params.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

        const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            ...(this.params.env ?? {}),
        };

        const transport = new StdioClientTransport({
            command: this.params.command,
            args: this.params.args ?? [],
            env,
            ...(this.params.cwd !== undefined ? { cwd: this.params.cwd } : {}),
            stderr: "inherit",
        });

        const client = new Client(
            { name: "tsagent", version: "0.1.0" },
            { capabilities: {} },
        );

        let timer: NodeJS.Timeout | null = null;
        try {
            await new Promise<void>((resolve, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`MCP connect timed out after ${timeoutMs}ms`));
                }, timeoutMs);
                client.connect(transport).then(
                    () => {
                        if (timer !== null) clearTimeout(timer);
                        resolve();
                    },
                    (error: unknown) => {
                        if (timer !== null) clearTimeout(timer);
                        reject(error instanceof Error ? error : new Error(String(error)));
                    },
                );
            });
        } catch (error) {
            try {
                await client.close();
            } catch {
                /* ignore cleanup failure */
            }
            try {
                await transport.close();
            } catch {
                /* ignore cleanup failure */
            }
            throw error;
        }

        this.client = client;
        this.transport = transport;
        this.connected = true;
    }

    async listTools(): Promise<Tool[]> {
        if (this.client === null) throw new Error("McpConnection: not connected");
        const result = await this.client.listTools();
        return result.tools;
    }

    async callTool(
        name: string,
        args: Record<string, unknown>,
        options: { signal?: AbortSignal } = {},
    ): Promise<CallToolResult> {
        let reconnectAttempted = false;
        for (; ;) {
            if (this.client === null) {
                if (reconnectAttempted) {
                    throw new Error("McpConnection: not connected (reconnect failed)");
                }
                reconnectAttempted = true;
                try {
                    await this.connect();
                } catch (reconnectError) {
                    throw new Error(
                        `McpConnection: reconnect failed: ${(reconnectError as Error).message}`,
                    );
                }
                continue;
            }

            try {
                const callOptions: { signal?: AbortSignal } = {};
                if (options.signal !== undefined) callOptions.signal = options.signal;
                const result = await this.client.callTool(
                    { name, arguments: args },
                    CallToolResultSchema,
                    callOptions,
                );
                return result as CallToolResult;
            } catch (error) {
                if (reconnectAttempted || !isClosedPipeError(error)) throw error;
                reconnectAttempted = true;

                // Attempt graceful close, then force-clear session state so a
                // half-dead transport cannot poison the retry.
                try {
                    await this.close();
                } catch {
                    /* ignore */
                }
                this.client = null;
                this.transport = null;
                this.connected = false;

                try {
                    await this.connect();
                } catch (reconnectError) {
                    throw new Error(
                        `McpConnection: reconnect after pipe failure failed: ${(reconnectError as Error).message}`,
                    );
                }
                // Loop retries the call against the fresh session.
            }
        }
    }

    async close(): Promise<void> {
        if (!this.connected) return;
        this.connected = false;
        const client = this.client;
        const transport = this.transport;
        this.client = null;
        this.transport = null;
        if (client !== null) {
            try {
                await client.close();
            } catch {
                /* ignore */
            }
        }
        if (transport !== null) {
            try {
                await transport.close();
            } catch {
                /* ignore */
            }
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }
}

// =========================================================================
// loadMcpTools
// =========================================================================

/**
 * Wrap each MCP tool as a `RemoteTool`.
 *
 * Permission resolution (highest priority first):
 *   1. Explicit `overrides[tool.name].permission` — always wins.
 *   2. `_meta.permission` — honored **only when
 *      `connection.trusted === true`**.
 *   3. `"dangerous"` when the server is untrusted and no override was
 *      supplied.
 *   4. `undefined` (resolves to `"read"` in `BaseTool`) when the server
 *      is trusted and reports no permission.
 */
export async function loadMcpTools(
    connection: McpConnection,
    overrides: Record<string, ToolOverrides> = {},
): Promise<RemoteTool[]> {
    const tools = await connection.listTools();
    const trusted = connection.trusted;
    const result: RemoteTool[] = [];

    for (const tool of tools) {
        const metaPermission = trusted ? readPermissionFromMeta(tool) : undefined;
        const explicit = overrides[tool.name] ?? {};

        const effectivePermission: PermissionTier | undefined =
            explicit.permission ??
            metaPermission ??
            (trusted ? undefined : "dangerous");

        const description =
            explicit.description ?? tool.description ?? `MCP tool "${tool.name}"`;

        const options: {
            name: string;
            description: string;
            inputSchema: Record<string, unknown>;
            permission?: PermissionTier;
            concurrencySafe?: boolean;
            timeoutMs?: number | null;
            callTool: (
                args: Record<string, unknown>,
                signal?: AbortSignal,
            ) => Promise<unknown[]>;
        } = {
            name: tool.name,
            description,
            inputSchema: tool.inputSchema as Record<string, unknown>,
            callTool: async (args, signal) => {
                const callOptions: { signal?: AbortSignal } = {};
                if (signal !== undefined) callOptions.signal = signal;
                const callResult = await connection.callTool(
                    tool.name,
                    args,
                    callOptions,
                );
                return mcpResultToMultipart(callResult, tool.name);
            },
        };
        if (effectivePermission !== undefined) {
            options.permission = effectivePermission;
        }
        if (explicit.concurrencySafe !== undefined) {
            options.concurrencySafe = explicit.concurrencySafe;
        }
        if (explicit.timeoutMs !== undefined) {
            options.timeoutMs = explicit.timeoutMs;
        }
        result.push(new RemoteTool(options));
    }
    return result;
}

function readPermissionFromMeta(tool: Tool): PermissionTier | undefined {
    const meta = (tool as { _meta?: unknown })._meta;
    if (meta === null || typeof meta !== "object") return undefined;
    const permission = (meta as Record<string, unknown>).permission;
    if (
        permission === "read" ||
        permission === "mutate" ||
        permission === "dangerous"
    ) {
        return permission;
    }
    return undefined;
}

// =========================================================================
// mcpResultToMultipart
// =========================================================================

/**
 * Convert an MCP `CallToolResult` into the shape `RemoteTool.callTool`
 * returns:
 * - `isError: true` → throw `McpToolError` with the SDK's prefix stripped.
 * - One content block → `[thatPart]`.
 * - Multiple content blocks → `[MultipartContent(parts)]`.
 * - Empty content + `structuredContent` → `[structuredPart]`.
 * - Empty content + no `structuredContent` → `[]`.
 */
export function mcpResultToMultipart(
    result: CallToolResult,
    toolName: string,
): unknown[] {
    if (result.isError === true) {
        throw new McpToolError(extractErrorMessage(result), toolName);
    }

    const parts: MultipartPart[] = [];
    for (const block of result.content) {
        parts.push(convertContentBlock(block));
    }

    if (
        parts.length === 0 &&
        result.structuredContent !== undefined &&
        result.structuredContent !== null
    ) {
        parts.push(structuredPart(result.structuredContent));
    }

    if (parts.length === 0) return [];
    if (parts.length === 1) return [parts[0]];
    return [multipart(parts)];
}

function convertContentBlock(block: unknown): MultipartPart {
    const b = block as Record<string, unknown>;
    const kind = b.type;

    if (kind === "text" && typeof b.text === "string") {
        return textPart(b.text);
    }
    if (kind === "image" && typeof b.data === "string") {
        const mimeType =
            typeof b.mimeType === "string" && b.mimeType.length > 0
                ? b.mimeType
                : "application/octet-stream";
        return imagePart(mimeType, b.data);
    }
    if (kind === "resource") {
        const resource = b.resource as Record<string, unknown> | null | undefined;
        if (resource !== null && resource !== undefined && typeof resource.uri === "string") {
            const uri = resource.uri;
            const mimeType =
                typeof resource.mimeType === "string" ? resource.mimeType : null;
            if (typeof resource.text === "string") {
                return resourcePart({ uri, mimeType, text: resource.text });
            }
            if (typeof resource.blob === "string") {
                return resourcePart({ uri, mimeType, blob: resource.blob });
            }
            return resourcePart({ uri, mimeType });
        }
    }
    if (kind === "resource_link" && typeof b.uri === "string") {
        const mimeType = typeof b.mimeType === "string" ? b.mimeType : null;
        return resourcePart({ uri: b.uri, mimeType });
    }
    return structuredPart(block);
}

function extractErrorMessage(result: CallToolResult): string {
    const texts: string[] = [];
    for (const block of result.content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
    const combined = texts.join("\n");
    return combined.replace(SDK_ERROR_PREFIX, "");
}