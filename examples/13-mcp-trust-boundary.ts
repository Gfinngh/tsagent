/**
 * 13 — The MCP trust boundary
 *
 * `loadMcpTools(connection)` respects each tool's `_meta.permission`
 * **only when the connection is trusted**. When you spawn the MCP
 * server yourself, that flag is `true`. When the command comes from an
 * environment override like `MCP_SERVER_COMMAND`, the flag is `false`
 * and `_meta.permission` is ignored — every tool without an explicit
 * override defaults to `dangerous`.
 *
 * This is what stops a compromised or misconfigured MCP server from
 * advertising "read" for a tool that actually mutates your files.
 *
 *   npx tsx examples/13-mcp-trust-boundary.ts
 */

import { McpConnection, loadMcpTools } from "../src/agent/client.js";
import { loadEnv, section } from "./_common.js";

loadEnv();

async function main(): Promise<void> {
    section("trusted connection (default) — _meta.permission honored");
    {
        const conn = new McpConnection("tsagent", {
            command: process.execPath,
            args: ["--import", "tsx", "src/agent/server.ts"],
            connectTimeoutMs: 30_000,
            trusted: true,
        });
        try {
            await conn.connect();
            const tools = await loadMcpTools(conn);
            for (const tool of tools) {
                console.log(
                    `  ${tool.name.padEnd(15)} permission=${tool.permission}`,
                );
            }
        } finally {
            await conn.close();
        }
    }

    section("untrusted connection — _meta.permission ignored");
    {
        const conn = new McpConnection("tsagent", {
            command: process.execPath,
            args: ["--import", "tsx", "src/agent/server.ts"],
            connectTimeoutMs: 30_000,
            trusted: false,
        });
        try {
            await conn.connect();
            const tools = await loadMcpTools(conn);
            for (const tool of tools) {
                console.log(
                    `  ${tool.name.padEnd(15)} permission=${tool.permission}`,
                );
            }
        } finally {
            await conn.close();
        }
    }

    section("untrusted connection with explicit overrides");
    {
        const conn = new McpConnection("tsagent", {
            command: process.execPath,
            args: ["--import", "tsx", "src/agent/server.ts"],
            connectTimeoutMs: 30_000,
            trusted: false,
        });
        try {
            await conn.connect();
            const tools = await loadMcpTools(conn, {
                calculator: { permission: "read" },
                write_file: { permission: "mutate" },
            });
            for (const tool of tools) {
                console.log(
                    `  ${tool.name.padEnd(15)} permission=${tool.permission}`,
                );
            }
        } finally {
            await conn.close();
        }
    }

    section("when is a connection untrusted?");
    console.log(
        "spawnMcpConnection() sets trusted=false when MCP_SERVER_COMMAND is set.",
    );
    console.log(
        "If you spawn the server yourself with `node --import tsx src/agent/server.ts`,",
    );
    console.log(
        "you get trusted=true and _meta.permission is honored. That is the default CLI path.",
    );
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});