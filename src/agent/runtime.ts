/**
 * Agent-runtime primitives that are neither workflow-specific nor
 * internal to the agent kernel:
 *
 * - `spawnMcpConnection`      spawn and connect to the MCP server child
 *                             process with a workspace root and
 *                             connect-timeout.
 * - `buildDefaultFallbackChain` construct the ordered `FallbackClient`
 *                             over the configured model chain.
 * - `defaultWorkflowConfirm`  the default confirmation policy for
 *                             workflow-triggered tool calls.
 * - `isMcpServerCommandOverridden` expose whether `MCP_SERVER_COMMAND`
 *                             was used, for callers that need it.
 *
 * These live here (not in `src/workflows/_shared.ts`) so the CLI
 * (`main.ts`) depends on runtime primitives rather than workflow
 * internals. The workflows reach them through `_shared.ts`'s
 * re-export, keeping the workflows' import path stable.
 */

import { McpConnection } from "./client.js";
import { FallbackClient, type FallbackEntry } from "./fallback.js";
import { LlmClient } from "./llm.js";
import { getModelChain, resolveModel } from "./models.js";
import { GoogleTransport } from "./transport/google.js";
import type { ToolCall } from "./schemas.js";
import type { BaseTool } from "./tools/base.js";

// =========================================================================
// MCP
// =========================================================================

/** True when `MCP_SERVER_COMMAND` is set to a non-empty value. */
export function isMcpServerCommandOverridden(): boolean {
    const envCommand = process.env.MCP_SERVER_COMMAND;
    return envCommand !== undefined && envCommand !== "";
}

/**
 * Spawn and connect to the MCP server child process.
 *
 * Trust model: if `MCP_SERVER_COMMAND` is set, we did not choose the
 * command — the operator did. The resulting `McpConnection` is flagged
 * `trusted: false`, which makes `loadMcpTools` ignore `_meta.permission`
 * (a hostile server could otherwise claim `read` on a `write_file`
 * equivalent and bypass the two-lock model). When we spawn our own
 * server (default path), the connection is `trusted: true`.
 */
export async function spawnMcpConnection(options: {
    workspaceRoot: string;
    connectTimeoutMs?: number;
}): Promise<McpConnection> {
    const envCommand = process.env.MCP_SERVER_COMMAND;
    const overridden = envCommand !== undefined && envCommand !== "";
    let command: string;
    let args: string[];
    if (overridden) {
        const parts = envCommand.split(/\s+/).filter((p) => p.length > 0);
        const first = parts[0];
        if (first === undefined) {
            throw new Error(
                `MCP_SERVER_COMMAND must not be empty or whitespace-only: ${JSON.stringify(envCommand)}`,
            );
        }
        command = first;
        args = parts.slice(1);
    } else {
        command = process.execPath;
        args = ["--import", "tsx", "src/agent/server.ts"];
    }
    const connection = new McpConnection("tsagent", {
        command,
        args,
        env: { WORKSPACE_ROOT: options.workspaceRoot },
        connectTimeoutMs: options.connectTimeoutMs ?? 30_000,
        trusted: !overridden,
    });
    await connection.connect();
    return connection;
}

// =========================================================================
// LLM
// =========================================================================

export function buildDefaultFallbackChain(
    modelOverride?: string,
): FallbackClient {
    const models =
        modelOverride !== undefined && modelOverride !== ""
            ? [modelOverride]
            : getModelChain();
    const entries: FallbackEntry[] = [];
    const failures: string[] = [];
    for (const model of models) {
        try {
            const resolved = resolveModel(model);
            const transport = new GoogleTransport(resolved);
            entries.push({
                // Keep the original (possibly prefixed) name so fallback metadata
                // matches what the operator configured.
                name: model,
                client: new LlmClient({ model: resolved, transport }),
            });
        } catch (error) {
            failures.push(`${model}: ${(error as Error).message}`);
        }
    }
    if (entries.length === 0) {
        throw new Error(
            `cannot construct any LLM client — check GEMINI_API_KEY / GOOGLE_API_KEY (${failures.join("; ")})`,
        );
    }
    return new FallbackClient({
        entries,
        // The chain is uniformly Gemini. Signatures are provider-specific, not
        // model-specific: a signature produced by gemini-3-flash-preview is a
        // valid Gemini signature and can be replayed to gemini-3.1-flash-lite.
        // Stripping on same-provider fallback throws that away, forcing the AI
        // SDK to inject `skip_thought_signature_validator` (which works but
        // logs a warning). Turn this back on only for mixed-provider chains.
        stripProviderOptionsOnSwitch: false,
    });
}

// =========================================================================
// Confirm callback
// =========================================================================

const WORKFLOW_AUTO_APPROVED_TOOLS: ReadonlySet<string> = new Set([
    "write_file",
    "remember",
    "forget",
]);

export function defaultWorkflowConfirm(
    allowDangerous: boolean,
): (toolCall: ToolCall, tool: BaseTool) => Promise<boolean> {
    return async (_, tool) => {
        if (tool.permission === "dangerous") return allowDangerous;
        if (tool.permission === "mutate") {
            return WORKFLOW_AUTO_APPROVED_TOOLS.has(tool.name);
        }
        return true;
    };
}