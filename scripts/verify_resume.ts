import { z } from "zod";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.js";
import { ExecutionContext } from "../src/agent/context.js";
import { JsonlEventLog, EventLogFormatError } from "../src/agent/event-log.js";
import { FunctionTool } from "../src/agent/tools/base.js";
import {
    makeEvent,
    messageContentItem,
    toolCallContentItem,
    toolResultContentItem,
} from "../src/agent/schemas.js";
import {
    ScriptedClient,
    expectThrows,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import { check, checkEqual, makeTempDir, runScript } from "./_verify-common.js";

runScript(async () => {
    const tmp = makeTempDir("resume-log");
    try {
        // ===== fromLog: basic text round-trip =====
        const textPath = join(tmp.path, "text.jsonl");
        {
            const log = new JsonlEventLog(textPath);
            log.append(makeEvent([messageContentItem({ role: "user", content: "hi" })]));
            log.append(
                makeEvent([messageContentItem({ role: "assistant", content: "hello" })]),
            );
            log.close();
        }
        const textCtx = ExecutionContext.fromLog(textPath);
        checkEqual(textCtx.events.length, 2, "fromLog/text: reads two events");
        check(textCtx.isFinished, "fromLog/text: recognizes finished run");
        if (textCtx.finalResult?.kind === "text") {
            checkEqual(textCtx.finalResult.text, "hello", "fromLog/text: final text");
        }

        // ===== fromLog: structured without outputToolName -> not finished =====
        const structuredPath = join(tmp.path, "structured.jsonl");
        {
            const log = new JsonlEventLog(structuredPath);
            log.append(makeEvent([messageContentItem({ role: "user", content: "go" })]));
            log.append(
                makeEvent([
                    messageContentItem({ role: "assistant", content: null }),
                    toolCallContentItem({
                        id: "c1",
                        name: "final_answer",
                        arguments: { output: { value: 42 } },
                        providerOptions: null,
                    }),
                ]),
            );
            log.append(
                makeEvent([
                    toolResultContentItem({
                        toolCallId: "c1",
                        name: "final_answer",
                        content: [{ output: { value: 42 } }],
                        status: "success",
                    }),
                ]),
            );
            log.close();
        }
        const withoutName = ExecutionContext.fromLog(structuredPath);
        check(
            withoutName.finalResult === null,
            "fromLog/no-outputToolName: structured run looks unfinished",
        );

        // ===== fromLog: structured with outputToolName -> finished =====
        const withName = ExecutionContext.fromLog(structuredPath, "final_answer");
        checkEqual(
            withName.finalResult?.kind,
            "structured",
            "fromLog/outputToolName: structured final recognized",
        );
        if (withName.finalResult?.kind === "structured") {
            checkEqual(
                withName.finalResult.output,
                { value: 42 },
                "fromLog/outputToolName: output unwrapped",
            );
        }

        // ===== fromLog: truncated tail warns and skips =====
        const truncPath = join(tmp.path, "trunc.jsonl");
        {
            const log = new JsonlEventLog(truncPath);
            log.append(makeEvent([messageContentItem({ role: "user", content: "a" })]));
            log.close();
            // Append a malformed unterminated tail manually.
            const { appendFileSync } = await import("node:fs");
            appendFileSync(truncPath, '{"id":"partial","timestamp":1');
        }
        let truncWarned = false;
        const truncCtx = ExecutionContext.fromLog(truncPath, undefined, {
            onTruncatedTail: () => {
                truncWarned = true;
            },
        });
        checkEqual(truncCtx.events.length, 1, "fromLog/truncated: one event survives");
        check(truncWarned, "fromLog/truncated: warning fired");

        // ===== fromLog: malformed interior line throws =====
        const badPath = join(tmp.path, "bad.jsonl");
        {
            const log = new JsonlEventLog(badPath);
            log.append(makeEvent([messageContentItem({ role: "user", content: "a" })]));
            log.close();
            const { appendFileSync } = await import("node:fs");
            appendFileSync(badPath, "not-json\n");
        }
        await expectThrows(
            async () => {
                ExecutionContext.fromLog(badPath);
            },
            EventLogFormatError,
            "fromLog/malformed: throws EventLogFormatError",
        );

        // ===== Full round-trip: run agent -> log -> fromLog -> resume =====
        const counter = { calls: 0 };
        const addTool = new FunctionTool({
            name: "add",
            description: "add",
            argsSchema: z.object({ a: z.number(), b: z.number() }),
            fn: ({ a, b }) => {
                counter.calls += 1;
                return a + b;
            },
        });
        const client1 = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "add", { a: 2, b: 3 })]),
            textResponse("5"),
        ]);
        const agent1 = new Agent({ llmClient: client1, tools: [addTool] });
        const originalResult = await agent1.run("add 2 and 3");

        const runPath = join(tmp.path, "run.jsonl");
        {
            const log = new JsonlEventLog(runPath);
            for (const event of originalResult.context.events) log.append(event);
            log.close();
        }

        const rehydrated = ExecutionContext.fromLog(runPath);
        checkEqual(
            rehydrated.events.length,
            originalResult.context.events.length,
            "round-trip: same event count",
        );
        checkEqual(
            rehydrated.currentStep,
            originalResult.context.currentStep,
            "round-trip: same currentStep",
        );
        check(rehydrated.isFinished, "round-trip: finished state preserved");

        // ===== Resume from rehydrated context: no-op =====
        const client2 = new ScriptedClient([]); // would throw if called
        const agent2 = new Agent({ llmClient: client2, tools: [addTool] });
        const resumed = await agent2.resume(rehydrated);
        checkEqual(client2.calls.length, 0, "round-trip/no-op: no LLM call");
        checkEqual(
            resumed.finalResult?.kind,
            "text",
            "round-trip/no-op: final result preserved",
        );

        // ===== Full round-trip: resume with follow-up =====
        const rehydrated2 = ExecutionContext.fromLog(runPath);
        const client3 = new ScriptedClient([textResponse("still 5")]);
        const agent3 = new Agent({ llmClient: client3, tools: [addTool] });
        const resumed2 = await agent3.resume(rehydrated2, {
            userMessage: "are you sure?",
        });
        checkEqual(client3.calls.length, 1, "round-trip/follow-up: one LLM call");
        checkEqual(
            resumed2.finalResult?.kind,
            "text",
            "round-trip/follow-up: new final result",
        );
        if (resumed2.finalResult?.kind === "text") {
            checkEqual(
                resumed2.finalResult.text,
                "still 5",
                "round-trip/follow-up: new final text",
            );
        }
    } finally {
        tmp.cleanup();
    }
});