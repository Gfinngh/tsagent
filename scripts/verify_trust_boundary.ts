/**
 * Verification: the MCP server trust boundary.
 *
 * A server's self-reported `_meta.permission` must be honored only when
 * the connection is trusted. When `MCP_SERVER_COMMAND` overrides the
 * spawn command, the resulting `McpConnection` must be flagged
 * untrusted, and every tool without an explicit override must default
 * to `dangerous` — regardless of what the server claims.
 *
 * Runs against real subprocesses and a real filesystem.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../src/agent/agent.js";
import { McpConnection, loadMcpTools } from "../src/agent/client.js";
import { spawnMcpConnection } from "../src/agent/runtime.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

function defaultSpawnArgs(): string[] {
    return ["--import", "tsx", "src/agent/server.ts"];
}

runScript(async () => {
    // =========================================================================
    // Section 1 — trusted server (default) honors _meta.permission
    // =========================================================================
    {
        const conn = new McpConnection("tsagent", {
            command: process.execPath,
            args: defaultSpawnArgs(),
            cwd: projectRoot,
            connectTimeoutMs: 30_000,
            // trusted defaults to true
        });
        checkEqual(conn.trusted, true, "trusted/default: connection.trusted === true");
        await conn.connect();
        try {
            const tools = await loadMcpTools(conn);
            const byName = new Map(tools.map((t) => [t.name, t]));
            checkEqual(
                byName.get("write_file")?.permission,
                "mutate",
                "trusted: write_file is mutate (via _meta)",
            );
            checkEqual(
                byName.get("execute_python")?.permission,
                "dangerous",
                "trusted: execute_python is dangerous (via _meta)",
            );
            checkEqual(
                byName.get("calculator")?.permission,
                "read",
                "trusted: calculator is read (via _meta)",
            );
        } finally {
            await conn.close();
        }
    }

    // =========================================================================
    // Section 2 — untrusted server ignores _meta.permission
    // =========================================================================
    {
        const conn = new McpConnection("tsagent", {
            command: process.execPath,
            args: defaultSpawnArgs(),
            cwd: projectRoot,
            connectTimeoutMs: 30_000,
            trusted: false,
        });
        checkEqual(conn.trusted, false, "untrusted: connection.trusted === false");
        await conn.connect();
        try {
            const tools = await loadMcpTools(conn);
            const byName = new Map(tools.map((t) => [t.name, t]));
            // Every tool defaults to dangerous — even write_file (server said
            // mutate) and calculator (server said read).
            checkEqual(
                byName.get("write_file")?.permission,
                "dangerous",
                "untrusted: write_file is dangerous (meta ignored)",
            );
            checkEqual(
                byName.get("execute_python")?.permission,
                "dangerous",
                "untrusted: execute_python is dangerous (default)",
            );
            checkEqual(
                byName.get("calculator")?.permission,
                "dangerous",
                "untrusted: calculator is dangerous (meta ignored)",
            );
            checkEqual(
                byName.get("greet")?.permission,
                "dangerous",
                "untrusted: greet is dangerous (meta ignored)",
            );
            // concurrencySafe should also be false for all tools.
            checkEqual(
                byName.get("calculator")?.concurrencySafe,
                false,
                "untrusted: calculator not concurrency-safe",
            );
        } finally {
            await conn.close();
        }
    }

    // =========================================================================
    // Section 3 — untrusted server, explicit overrides still win
    // =========================================================================
    {
        const conn = new McpConnection("tsagent", {
            command: process.execPath,
            args: defaultSpawnArgs(),
            cwd: projectRoot,
            connectTimeoutMs: 30_000,
            trusted: false,
        });
        await conn.connect();
        try {
            const tools = await loadMcpTools(conn, {
                calculator: { permission: "read" },
                write_file: { permission: "mutate" },
                execute_python: { permission: "dangerous", timeoutMs: 5000 },
            });
            const byName = new Map(tools.map((t) => [t.name, t]));
            checkEqual(
                byName.get("calculator")?.permission,
                "read",
                "untrusted+override: calculator is read (explicit)",
            );
            checkEqual(
                byName.get("write_file")?.permission,
                "mutate",
                "untrusted+override: write_file is mutate (explicit)",
            );
            checkEqual(
                byName.get("execute_python")?.timeoutMs,
                5000,
                "untrusted+override: execute_python timeoutMs applied",
            );
            // A tool with no override stays dangerous.
            checkEqual(
                byName.get("greet")?.permission,
                "dangerous",
                "untrusted+override: greet stays dangerous (no override)",
            );
        } finally {
            await conn.close();
        }
    }

    // =========================================================================
    // Section 4 — spawn with MCP_SERVER_COMMAND set → untrusted
    // =========================================================================
    {
        const originalCommand = process.env.MCP_SERVER_COMMAND;
        process.env.MCP_SERVER_COMMAND = `${process.execPath} --import tsx src/agent/server.ts`;
        try {
            const conn = await spawnMcpConnection({ workspaceRoot: projectRoot });
            try {
                checkEqual(
                    conn.trusted,
                    false,
                    "spawn/override: connection.trusted === false",
                );
                const tools = await loadMcpTools(conn);
                const byName = new Map(tools.map((t) => [t.name, t]));
                checkEqual(
                    byName.get("write_file")?.permission,
                    "dangerous",
                    "spawn/override: write_file is dangerous",
                );
                checkEqual(
                    byName.get("calculator")?.permission,
                    "dangerous",
                    "spawn/override: calculator is dangerous",
                );
            } finally {
                await conn.close();
            }
        } finally {
            if (originalCommand === undefined) {
                delete process.env.MCP_SERVER_COMMAND;
            } else {
                process.env.MCP_SERVER_COMMAND = originalCommand;
            }
        }
    }

    // =========================================================================
    // Section 5 — spawn without MCP_SERVER_COMMAND → trusted
    // =========================================================================
    {
        const originalCommand = process.env.MCP_SERVER_COMMAND;
        delete process.env.MCP_SERVER_COMMAND;
        try {
            const conn = await spawnMcpConnection({ workspaceRoot: projectRoot });
            try {
                checkEqual(
                    conn.trusted,
                    true,
                    "spawn/default: connection.trusted === true",
                );
                const tools = await loadMcpTools(conn);
                const byName = new Map(tools.map((t) => [t.name, t]));
                checkEqual(
                    byName.get("write_file")?.permission,
                    "mutate",
                    "spawn/default: write_file is mutate (meta honored)",
                );
            } finally {
                await conn.close();
            }
        } finally {
            if (originalCommand !== undefined) {
                process.env.MCP_SERVER_COMMAND = originalCommand;
            }
        }
    }

    // =========================================================================
    // Section 6 — end-to-end: untrusted write_file denied without allowDangerous
    // =========================================================================
    {
        const conn = new McpConnection("tsagent", {
            command: process.execPath,
            args: defaultSpawnArgs(),
            cwd: projectRoot,
            connectTimeoutMs: 30_000,
            trusted: false,
        });
        await conn.connect();
        try {
            const tools = await loadMcpTools(conn);
            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "write_file", {
                        path: "trust-test.txt",
                        content: "should not exist",
                    }),
                ]),
                textResponse("done"),
            ]);
            // No allowDangerous, no confirm callback.
            const agent = new Agent({ llmClient: client, tools });
            const result = await agent.run("try to write");

            const toolResult = result.context.events
                .flatMap((e) => e.content)
                .find((c) => c.type === "tool_result");
            if (toolResult?.type === "tool_result") {
                checkEqual(
                    toolResult.toolResult.status,
                    "error",
                    "e2e: untrusted write_file denied",
                );
                const reason = String(toolResult.toolResult.content[0]);
                check(
                    reason.includes("dangerous") || reason.includes("allowDangerous"),
                    `e2e: reason mentions dangerous/allowDangerous (got: ${reason})`,
                );
            } else {
                check(false, "e2e: tool_result event present");
            }
        } finally {
            await conn.close();
        }
    }
});