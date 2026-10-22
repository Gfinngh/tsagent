import { z } from "zod";
import {
    Agent,
    AgentTimeoutError,
    CancelledError,
} from "../src/agent/agent.js";
import {
    BaseTool,
    FunctionTool,
} from "../src/agent/tools/base.js";
import {
    ScriptedClient,
    expectThrows,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

/**
 * A tool that never resolves unless its signal is aborted. Honors the
 * signal so tests exit cleanly.
 */
function hangTool(name: string, timeoutMs: number | null): BaseTool {
    return new FunctionTool({
        name,
        description: "hangs",
        ...(timeoutMs !== null ? { timeoutMs } : {}),
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
}

runScript(async () => {
    // ===== Per-tool timeout produces error ToolResult, loop continues =====
    {
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "slow")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [hangTool("slow", 50)],
        });
        const result = await agent.run("go");

        checkEqual(result.context.currentStep, 2, "tool-timeout: two steps");
        check(result.finalResult?.kind === "text", "tool-timeout: text final");
        const toolResult = result.context.events
            .flatMap((e) => e.content)
            .find((c) => c.type === "tool_result");
        if (toolResult?.type === "tool_result") {
            checkEqual(toolResult.toolResult.status, "error", "tool-timeout: error status");
            check(
                String(toolResult.toolResult.content[0]).includes("timed out"),
                "tool-timeout: message mentions 'timed out'",
            );
        } else {
            check(false, "tool-timeout: tool_result event found");
        }
    }

    // ===== Run timeout throws AgentTimeoutError =====
    {
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "hang")]),
            // Second response unused — the run times out during tool execution.
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [hangTool("hang", null)],
            runTimeoutMs: 80,
        });
        await expectThrows(
            () => agent.run("go"),
            AgentTimeoutError,
            "run-timeout: throws AgentTimeoutError",
        );
    }

    // ===== Outer cancellation -> CancelledError =====
    {
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "hang")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [hangTool("hang", null)],
        });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 40);
        await expectThrows(
            () => agent.run("go", { signal: controller.signal }),
            CancelledError,
            "cancel: throws CancelledError",
        );
    }

    // ===== Cancellation wins even when a run timeout is also configured =====
    {
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "hang")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [hangTool("hang", null)],
            runTimeoutMs: 500,
        });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 40);
        await expectThrows(
            () => agent.run("go", { signal: controller.signal }),
            CancelledError,
            "cancel-precedence: CancelledError, not AgentTimeoutError",
        );
    }

    // ===== Run timeout during a tool whose own timeout is longer =====
    // The run timeout fires first → AgentTimeoutError, NOT a per-tool timeout result.
    {
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "slow")]),
            textResponse("done"),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [hangTool("slow", 500)],
            runTimeoutMs: 80,
        });
        await expectThrows(
            () => agent.run("go"),
            AgentTimeoutError,
            "run-vs-tool: run timeout wins",
        );
    }

    // ===== Tool with no timeoutMs never times out on its own =====
    {
        const quickTool = new FunctionTool({
            name: "quick",
            description: "quick",
            argsSchema: z.object({}),
            fn: async () => {
                await new Promise((r) => setTimeout(r, 10));
                return "done";
            },
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "quick")]),
            textResponse("ok"),
        ]);
        const agent = new Agent({ llmClient: client, tools: [quickTool] });
        const result = await agent.run("go");
        check(result.finalResult?.kind === "text", "no-timeout: tool completes normally");
    }
});