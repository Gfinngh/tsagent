import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(async () => {
    const OutputSchema = z.object({
        answer: z.string(),
        confidence: z.number(),
    });

    // ===== final_answer tool is injected + toolChoice required =====
    {
        const client = new ScriptedClient([
            toolCallResponse([
                makeToolCall("c1", "final_answer", {
                    output: { answer: "42", confidence: 0.9 },
                }),
            ]),
        ]);
        const agent = new Agent({
            llmClient: client,
            outputType: OutputSchema,
            maxSteps: 2,
        });
        const result = await agent.run("what is 6*7?");

        // Request shape
        const call = client.calls[0];
        checkEqual(call?.toolChoice, "required", "structured: toolChoice required");
        const names = call?.tools?.map((t) => t.function.name) ?? [];
        check(names.includes("final_answer"), "structured: final_answer tool injected");
        checkEqual(names.length, 1, "structured: only final_answer in tools");

        // Tool definition shape
        const def = call?.tools?.[0];
        checkEqual(def?.function.name, "final_answer", "structured: definition name");
        const params = def?.function.parameters as {
            properties?: { output?: unknown };
            required?: string[];
        };
        check(params.properties !== undefined, "structured: parameters has properties");
        checkEqual(
            params.required,
            ["output"],
            "structured: 'output' is required",
        );

        // Result
        check(result.finalResult !== null, "structured: finalResult present");
        checkEqual(
            result.finalResult?.kind,
            "structured",
            "structured: kind is 'structured'",
        );
        if (result.finalResult?.kind === "structured") {
            checkEqual(
                result.finalResult.output,
                { answer: "42", confidence: 0.9 },
                "structured: output unwrapped",
            );
        }
    }

    // ===== Invalid arguments -> error result, loop continues =====
    {
        const client = new ScriptedClient([
            toolCallResponse([
                makeToolCall("c1", "final_answer", { wrong: "shape" }),
            ]),
            toolCallResponse([
                makeToolCall("c2", "final_answer", {
                    output: { answer: "correct", confidence: 1 },
                }),
            ]),
        ]);
        const agent = new Agent({
            llmClient: client,
            outputType: OutputSchema,
            maxSteps: 5,
        });
        const result = await agent.run("retry");

        checkEqual(result.context.currentStep, 2, "invalid-args: two steps");
        check(
            result.finalResult?.kind === "structured",
            "invalid-args: eventually gets structured result",
        );

        const firstToolResult = result.context.events
            .flatMap((e) => e.content)
            .filter((c) => c.type === "tool_result")[0];
        if (firstToolResult?.type === "tool_result") {
            checkEqual(
                firstToolResult.toolResult.status,
                "error",
                "invalid-args: first result has error status",
            );
            check(
                String(firstToolResult.toolResult.content[0]).includes("invalid"),
                "invalid-args: first result mentions 'invalid'",
            );
        }
    }

    // ===== Final answer with tools also present =====
    {
        const addTool = new (await import("../src/agent/tools/base.js")).FunctionTool({
            name: "add",
            description: "add",
            argsSchema: z.object({ a: z.number(), b: z.number() }),
            fn: ({ a, b }) => a + b,
        });
        const client = new ScriptedClient([
            toolCallResponse([
                makeToolCall("c1", "final_answer", {
                    output: { answer: "precomputed", confidence: 1 },
                }),
            ]),
        ]);
        const agent = new Agent({
            llmClient: client,
            tools: [addTool],
            outputType: OutputSchema,
        });
        const result = await agent.run("go");
        checkEqual(result.finalResult?.kind, "structured", "with-tools: structured result");
        const names = client.calls[0]?.tools?.map((t) => t.function.name) ?? [];
        check(names.includes("add"), "with-tools: user tool also present");
        check(names.includes("final_answer"), "with-tools: final_answer also present");
    }

    // ===== maxSteps with structured output =====
    {
        const client = new ScriptedClient([
            toolCallResponse([
                makeToolCall("c1", "final_answer", { wrong: 1 }),
            ]),
            toolCallResponse([
                makeToolCall("c2", "final_answer", { wrong: 2 }),
            ]),
            toolCallResponse([
                makeToolCall("c3", "final_answer", { wrong: 3 }),
            ]),
        ]);
        const agent = new Agent({
            llmClient: client,
            outputType: OutputSchema,
            maxSteps: 2,
        });
        const result = await agent.run("go");
        checkEqual(result.stoppedByMaxSteps, true, "maxsteps-structured: stopped");
        check(result.finalResult === null, "maxsteps-structured: no final result");
    }

    // ===== Free-form (no outputType) has no final_answer =====
    {
        const client = new ScriptedClient([textResponse("hello")]);
        const agent = new Agent({ llmClient: client });
        await agent.run("go");
        const names = client.calls[0]?.tools?.map((t) => t.function.name) ?? [];
        check(!names.includes("final_answer"), "free-form: no final_answer tool");
        checkEqual(
            client.calls[0]?.toolChoice,
            undefined,
            "free-form: no toolChoice",
        );
    }

    // ===== outputType + no tools = still requires final_answer =====
    {
        const client = new ScriptedClient([
            toolCallResponse([
                makeToolCall("c1", "final_answer", {
                    output: { answer: "x", confidence: 1 },
                }),
            ]),
        ]);
        const agent = new Agent({ llmClient: client, outputType: OutputSchema });
        await agent.run("go");
        checkEqual(
            client.calls[0]?.toolChoice,
            "required",
            "outputType-only: toolChoice required",
        );
    }
});