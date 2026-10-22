/**
 * Verification: tool error provenance (`ToolResult.errorKind`).
 *
 * Asserts that every error production site in `Agent` tags its result
 * with the correct kind:
 *
 *   domain    — `ToolError`, `McpToolError`, `ZodError`, unknown tool,
 *               invalid `final_answer` args
 *   exception — unexpected throw from a tool implementation
 *   denied    — permission failure (including a throwing confirm callback)
 *   timeout   — per-tool `timeoutMs` elapsed
 *   null      — success
 *
 * Also covers:
 *   - `errorKind` defaults to null when rehydrating pre-fix logs
 *   - `McpToolError extends ToolError` so MCP errors classify as domain
 */

import { z } from "zod";
import {
    Agent,
} from "../src/agent/agent.js";
import { McpConnection, loadMcpTools } from "../src/agent/client.js";
import type { ToolResult, AgentEvent } from "../src/agent/schemas.js";
import {
    AgentEventSchema,
    makeEvent,
    messageContentItem,
    toolCallContentItem,
    toolResultContentItem,
} from "../src/agent/schemas.js";
import { FunctionTool, ToolError } from "../src/agent/tools/base.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

function findToolResult(
    result: { context: { events: AgentEvent[] } },
    toolCallId: string,
): ToolResult | null {
    for (const event of result.context.events) {
        for (const item of event.content) {
            if (item.type === "tool_result" && item.toolResult.toolCallId === toolCallId) {
                return item.toolResult;
            }
        }
    }
    return null;
}

runScript(async () => {
    // =========================================================================
    // 1. Success → errorKind null
    // =========================================================================
    {
        const okTool = new FunctionTool({
            name: "ok",
            description: "returns ok",
            argsSchema: z.object({}),
            fn: () => "ok",
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "ok")]),
            textResponse("done"),
        ]);
        const agent = new Agent({ llmClient: client, tools: [okTool] });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        check(toolResult !== null, "success: tool_result present");
        checkEqual(toolResult?.status, "success", "success: status success");
        checkEqual(toolResult?.errorKind, null, "success: errorKind null");
    }

    // =========================================================================
    // 2. ToolError → domain
    // =========================================================================
    {
        const badTool = new FunctionTool({
            name: "bad",
            description: "throws ToolError",
            argsSchema: z.object({}),
            fn: () => {
                throw new ToolError("intentional domain failure");
            },
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "bad")]),
            textResponse("done"),
        ]);
        const agent = new Agent({ llmClient: client, tools: [badTool] });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "error", "toolerror: status error");
        checkEqual(toolResult?.errorKind, "domain", "toolerror: errorKind domain");
        check(
            String(toolResult?.content[0]).includes("intentional domain failure"),
            "toolerror: message preserved",
        );
    }

    // =========================================================================
    // 3. Generic Error → exception
    // =========================================================================
    {
        const boomTool = new FunctionTool({
            name: "boom",
            description: "throws Error",
            argsSchema: z.object({}),
            fn: () => {
                throw new Error("unexpected boom");
            },
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "boom")]),
            textResponse("done"),
        ]);
        const agent = new Agent({ llmClient: client, tools: [boomTool] });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "error", "exception: status error");
        checkEqual(toolResult?.errorKind, "exception", "exception: errorKind exception");
    }

    // =========================================================================
    // 4. ZodError from bad args → domain
    // =========================================================================
    {
        const typedTool = new FunctionTool({
            name: "typed",
            description: "expects { x: string }",
            argsSchema: z.object({ x: z.string() }),
            fn: ({ x }) => `got ${x}`,
        });
        const client = new ScriptedClient([
            // Deliberately wrong type: x is a number.
            toolCallResponse([makeToolCall("c1", "typed", { x: 1 })]),
            textResponse("done"),
        ]);
        const agent = new Agent({ llmClient: client, tools: [typedTool] });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "error", "zoderror: status error");
        checkEqual(toolResult?.errorKind, "domain", "zoderror: errorKind domain");
    }

    // =========================================================================
    // 5. Mutate without callback → denied
    // =========================================================================
    {
        const mutateTool = new FunctionTool({
            name: "mutate",
            description: "mutate tool",
            permission: "mutate",
            argsSchema: z.object({}),
            fn: () => "ok",
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "mutate")]),
            textResponse("done"),
        ]);
        const agent = new Agent({ llmClient: client, tools: [mutateTool] });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "error", "denied/mutate: status error");
        checkEqual(toolResult?.errorKind, "denied", "denied/mutate: errorKind denied");
    }

    // =========================================================================
    // 6. Mutate with callback returning false → denied
    // =========================================================================
    {
        const mutateTool = new FunctionTool({
            name: "mutate",
            description: "mutate tool",
            permission: "mutate",
            argsSchema: z.object({}),
            fn: () => "ok",
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "mutate")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [mutateTool],
            confirmToolCall: () => false,
        });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.errorKind, "denied", "denied/false: errorKind denied");
    }

    // =========================================================================
    // 7. Dangerous with allowDangerous false → denied
    // =========================================================================
    {
        const dangerTool = new FunctionTool({
            name: "danger",
            description: "dangerous tool",
            permission: "dangerous",
            argsSchema: z.object({}),
            fn: () => "ok",
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "danger")]),
            textResponse("done"),
        ]);
        const agent = new Agent({ llmClient: client, tools: [dangerTool] });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.errorKind, "denied", "denied/dangerous: errorKind denied");
    }

    // =========================================================================
    // 8. Dangerous with allowDangerous but no callback → denied
    // =========================================================================
    {
        const dangerTool = new FunctionTool({
            name: "danger",
            description: "dangerous tool",
            permission: "dangerous",
            argsSchema: z.object({}),
            fn: () => "ok",
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "danger")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [dangerTool],
            allowDangerous: true,
        });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        checkEqual(
            toolResult?.errorKind,
            "denied",
            "denied/no-callback: errorKind denied",
        );
    }

    // =========================================================================
    // 9. Confirm callback throws → denied
    // =========================================================================
    {
        const mutateTool = new FunctionTool({
            name: "mutate",
            description: "mutate tool",
            permission: "mutate",
            argsSchema: z.object({}),
            fn: () => "ok",
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "mutate")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [mutateTool],
            confirmToolCall: () => {
                throw new Error("approval service unavailable");
            },
        });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        checkEqual(
            toolResult?.errorKind,
            "denied",
            "denied/callback-throws: errorKind denied",
        );
        check(
            String(toolResult?.content[0]).includes("approval service unavailable"),
            "denied/callback-throws: original message preserved",
        );
    }

    // =========================================================================
    // 10. Unknown tool → domain
    // =========================================================================
    {
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "ghost")]),
            textResponse("done"),
        ]);
        const agent = new Agent({ llmClient: client });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "error", "unknown: status error");
        checkEqual(toolResult?.errorKind, "domain", "unknown: errorKind domain");
        check(
            String(toolResult?.content[0]).includes("not found"),
            "unknown: message mentions 'not found'",
        );
    }

    // =========================================================================
    // 11. Per-tool timeout → timeout
    // =========================================================================
    {
        const hangTool = new FunctionTool({
            name: "hang",
            description: "hangs",
            timeoutMs: 50,
            argsSchema: z.object({}),
            fn: (_args, signal?: AbortSignal) =>
                new Promise<string>((resolve, reject) => {
                    const timer = setTimeout(() => resolve("done"), 10_000);
                    if (signal === undefined) return;
                    signal.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(timer);
                            const err = new Error("aborted");
                            err.name = "AbortError";
                            reject(err);
                        },
                        { once: true },
                    );
                }),
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "hang")]),
            textResponse("done"),
        ]);
        const agent = new Agent({ llmClient: client, tools: [hangTool] });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "error", "timeout: status error");
        checkEqual(toolResult?.errorKind, "timeout", "timeout: errorKind timeout");
        check(
            String(toolResult?.content[0]).includes("timed out"),
            "timeout: message mentions 'timed out'",
        );
    }

    // =========================================================================
    // 12. Invalid final_answer args → domain
    // =========================================================================
    {
        const OutputSchema = z.object({ answer: z.string() });
        const client = new ScriptedClient([
            toolCallResponse([
                makeToolCall("c1", "final_answer", { wrong: "shape" }),
            ]),
            // Second response valid so the run terminates.
            toolCallResponse([
                makeToolCall("c2", "final_answer", { output: { answer: "ok" } }),
            ]),
        ]);
        const agent = new Agent({
            llmClient: client,
            outputType: OutputSchema,
            maxSteps: 5,
        });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        checkEqual(
            toolResult?.status,
            "error",
            "final-answer/invalid: status error",
        );
        checkEqual(
            toolResult?.errorKind,
            "domain",
            "final-answer/invalid: errorKind domain",
        );

        // The second, valid call succeeds with errorKind null.
        const successResult = findToolResult(result, "c2");
        checkEqual(
            successResult?.status,
            "success",
            "final-answer/valid: status success",
        );
        checkEqual(
            successResult?.errorKind,
            null,
            "final-answer/valid: errorKind null",
        );
    }

    // =========================================================================
    // 13. MCP tool error → domain (via McpToolError extends ToolError)
    // =========================================================================
    {
        const connection = new McpConnection("tsagent", {
            command: process.execPath,
            args: ["--import", "tsx", "src/agent/server.ts"],
            connectTimeoutMs: 30_000,
        });
        try {
            await connection.connect();
            const tools = await loadMcpTools(connection);
            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "calculator", { expression: "1 / 0" }),
                ]),
                textResponse("done"),
            ]);
            const agent = new Agent({ llmClient: client, tools });
            const result = await agent.run("go");
            const toolResult = findToolResult(result, "c1");
            checkEqual(toolResult?.status, "error", "mcp-error: status error");
            checkEqual(
                toolResult?.errorKind,
                "domain",
                "mcp-error: errorKind domain (McpToolError extends ToolError)",
            );
            checkEqual(
                String(toolResult?.content[0]),
                "division by zero",
                "mcp-error: message preserved",
            );
        } finally {
            await connection.close();
        }
    }

    // =========================================================================
    // 14. Old events (no errorKind) parse with errorKind: null
    // =========================================================================
    {
        const oldEvent = {
            id: "11111111-1111-1111-1111-111111111111",
            timestamp: 1,
            content: [
                {
                    type: "tool_result",
                    toolResult: {
                        toolCallId: "c1",
                        name: "old",
                        content: ["ancient error"],
                        status: "error",
                        // Note: no errorKind — represents a pre-fix event log.
                    },
                },
            ],
        };
        const parsed = AgentEventSchema.parse(oldEvent);
        const toolResult = parsed.content[0];
        if (toolResult?.type !== "tool_result") {
            check(false, "old-log: content item is tool_result");
            return;
        }
        checkEqual(
            toolResult.toolResult.errorKind,
            null,
            "old-log: errorKind defaults to null on rehydrate",
        );
        checkEqual(
            toolResult.toolResult.status,
            "error",
            "old-log: status preserved",
        );
    }

    // =========================================================================
    // 15. errorKind survives JSON round-trip through the event log path
    // =========================================================================
    {
        const errorResult: ToolResult = {
            toolCallId: "c1",
            name: "x",
            content: ["err"],
            status: "error",
            errorKind: "domain",
        };
        const event = makeEvent([toolResultContentItem(errorResult)]);
        const serialized = JSON.stringify(event);
        const reparsed = AgentEventSchema.parse(JSON.parse(serialized));
        const toolResult = reparsed.content[0];
        if (toolResult?.type !== "tool_result") {
            check(false, "roundtrip: content is tool_result");
            return;
        }
        checkEqual(
            toolResult.toolResult.errorKind,
            "domain",
            "roundtrip: errorKind survives JSON round-trip",
        );
    }

    // Suppress unused-import warnings on helpers we only use for type
    // compatibility checks (makeEvent / messageContentItem / toolCallContentItem
    // are exercised elsewhere).
    void messageContentItem;
    void toolCallContentItem;
});