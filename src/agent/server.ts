/**
 * MCP server. Exposes the project's tools over stdio.
 *
 * Stdout is reserved for JSON-RPC frames. Every diagnostic goes to
 * stderr. The tool set:
 *   - `calculator`      (read)
 *   - `greet`           (read)
 *   - `list_files`      (read)
 *   - `read_file`       (read)
 *   - `write_file`      (mutate)
 *   - `search_web`      (read; requires TAVILY_API_KEY)
 *   - `execute_python`  (dangerous; requires Deno + Pyodide cache)
 *
 * Each tool's permission tier is advertised via `_meta.permission` so
 * the client can construct the correct `RemoteTool` without hard-coding
 * a duplicate list. The client remains free to override via explicit
 * `ToolOverrides` — which is required for genuinely untrusted servers.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { BaseTool, ToolError } from "./tools/base.js";
import { calculatorTool } from "./tools/calculator.js";
import { greetTool } from "./tools/greet.js";
import { makeExecutePythonTool } from "./tools/python.js";
import { makeSearchWebTool } from "./tools/search.js";
import { makeFileTools } from "./tools/workspace.js";

function buildTools(): BaseTool[] {
    const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
    return [
        calculatorTool,
        greetTool,
        ...makeFileTools({ workspaceRoot }),
        makeSearchWebTool(),
        makeExecutePythonTool(),
    ];
}

const TOOLS: BaseTool[] = buildTools();

const server = new Server(
    { name: "tsagent", version: "0.1.0" },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => {
        const def = tool.toolDefinition();
        return {
            name: def.function.name,
            description: def.function.description,
            inputSchema: def.function.parameters,
            // MCP extension field. Preserved by the SDK's stdio transport.
            // The client reads this to seed the tool's permission tier.
            _meta: { permission: tool.permission },
        };
    }),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) {
        return {
            content: [{ type: "text", text: `Tool "${name}" not found` }],
            isError: true,
        };
    }

    try {
        const content = await tool.run(args);
        return {
            content: contentToMcpBlocks(content),
            isError: false,
        };
    } catch (error) {
        const message =
            error instanceof ToolError
                ? error.message
                : error instanceof Error
                    ? error.message
                    : String(error);
        return {
            content: [{ type: "text", text: message }],
            isError: true,
        };
    }
});

function contentToMcpBlocks(
    content: unknown[],
): Array<{ type: "text"; text: string }> {
    if (content.length === 0) {
        return [{ type: "text" as const, text: "" }];
    }
    return content.map((item) => ({
        type: "text" as const,
        text: typeof item === "string" ? item : JSON.stringify(item, null, 2),
    }));
}

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    process.stderr.write(`tsagent MCP server failed: ${String(error)}\n`);
    process.exit(1);
});