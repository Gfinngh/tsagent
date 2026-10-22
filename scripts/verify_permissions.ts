import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import { FunctionTool } from "../src/agent/tools/base.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(async () => {
    const makeReadTool = (counter: { calls: number }) =>
        new FunctionTool({
            name: "read_tool",
            description: "read",
            argsSchema: z.object({}),
            fn: () => {
                counter.calls += 1;
                return "read result";
            },
        });

    const makeMutateTool = (counter: { calls: number }) =>
        new FunctionTool({
            name: "mutate_tool",
            description: "mutate",
            permission: "mutate",
            argsSchema: z.object({}),
            fn: () => {
                counter.calls += 1;
                return "mutate result";
            },
        });

    const makeDangerousTool = (counter: { calls: number }) =>
        new FunctionTool({
            name: "dangerous_tool",
            description: "dangerous",
            permission: "dangerous",
            argsSchema: z.object({}),
            fn: () => {
                counter.calls += 1;
                return "dangerous result";
            },
        });

    // ===== read: no callback required =====
    {
        const counter = { calls: 0 };
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "read_tool")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [makeReadTool(counter)],
        });
        const result = await agent.run("go");
        checkEqual(counter.calls, 1, "read: tool executed");
        check(result.finalResult?.kind === "text", "read: final answer");
    }

    // ===== mutate: no callback -> denied, never invoked =====
    {
        const counter = { calls: 0 };
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "mutate_tool")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [makeMutateTool(counter)],
        });
        const result = await agent.run("go");
        checkEqual(counter.calls, 0, "mutate/no-callback: tool NOT invoked");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "error", "mutate/no-callback: error status");
        check(
            String(toolResult?.content[0]).includes("confirmation"),
            "mutate/no-callback: reason mentions confirmation",
        );
    }

    // ===== mutate: callback returns false -> denied =====
    {
        const counter = { calls: 0 };
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "mutate_tool")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [makeMutateTool(counter)],
            confirmToolCall: () => false,
        });
        const result = await agent.run("go");
        checkEqual(counter.calls, 0, "mutate/false: tool NOT invoked");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "error", "mutate/false: error status");
    }

    // ===== mutate: callback returns true -> allowed =====
    {
        const counter = { calls: 0 };
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "mutate_tool")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [makeMutateTool(counter)],
            confirmToolCall: () => true,
        });
        const result = await agent.run("go");
        checkEqual(counter.calls, 1, "mutate/true: tool invoked");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "success", "mutate/true: success");
    }

    // ===== dangerous: allowDangerous false -> denied, callback not consulted =====
    {
        const counter = { calls: 0 };
        let callbackConsulted = false;
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "dangerous_tool")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [makeDangerousTool(counter)],
            allowDangerous: false,
            confirmToolCall: () => {
                callbackConsulted = true;
                return true;
            },
        });
        const result = await agent.run("go");
        checkEqual(counter.calls, 0, "dangerous/off: tool NOT invoked");
        checkEqual(
            callbackConsulted,
            false,
            "dangerous/off: callback NOT consulted",
        );
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "error", "dangerous/off: error status");
        check(
            String(toolResult?.content[0]).includes("allowDangerous"),
            "dangerous/off: reason mentions allowDangerous",
        );
    }

    // ===== dangerous: allowDangerous true but no callback -> denied =====
    {
        const counter = { calls: 0 };
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "dangerous_tool")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [makeDangerousTool(counter)],
            allowDangerous: true,
        });
        const result = await agent.run("go");
        checkEqual(counter.calls, 0, "dangerous/no-callback: tool NOT invoked");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "error", "dangerous/no-callback: error");
    }

    // ===== dangerous: allowDangerous true + callback true -> allowed =====
    {
        const counter = { calls: 0 };
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "dangerous_tool")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [makeDangerousTool(counter)],
            allowDangerous: true,
            confirmToolCall: () => true,
        });
        const result = await agent.run("go");
        checkEqual(counter.calls, 1, "dangerous/on+true: tool invoked");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "success", "dangerous/on+true: success");
    }

    // ===== callback throws -> error ToolResult, tool not invoked =====
    {
        const counter = { calls: 0 };
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "mutate_tool")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [makeMutateTool(counter)],
            confirmToolCall: () => {
                throw new Error("approval service down");
            },
        });
        const result = await agent.run("go");
        checkEqual(counter.calls, 0, "callback-throws: tool NOT invoked");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "error", "callback-throws: error status");
        check(
            String(toolResult?.content[0]).includes("approval service down"),
            "callback-throws: message propagated",
        );
    }

    // ===== unknown tool -> error ToolResult, not found =====
    {
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "ghost")]),
            textResponse("done"),
        ]);
        const agent = new Agent({ llmClient: client });
        const result = await agent.run("go");
        const toolResult = findToolResult(result, "c1");
        checkEqual(toolResult?.status, "error", "unknown: error status");
        check(
            String(toolResult?.content[0]).includes("not found"),
            "unknown: message mentions 'not found'",
        );
    }
});

function findToolResult(
    result: { context: { events: Array<{ content: Array<{ type: string; toolResult?: { toolCallId: string; status: string; content: unknown[] } }> }> } },
    toolCallId: string,
): { status: string; content: unknown[] } | null {
    for (const event of result.context.events) {
        for (const item of event.content) {
            if (item.type === "tool_result" && item.toolResult?.toolCallId === toolCallId) {
                return { status: item.toolResult.status, content: item.toolResult.content };
            }
        }
    }
    return null;
}