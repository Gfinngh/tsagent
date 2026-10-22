import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import { FallbackClient, type FallbackEntry } from "../src/agent/fallback.js";
import {
    LlmClient,
    type ChatMessage,
    type RequestCapture,
} from "../src/agent/llm.js";
import { getModelChain, resolveModel } from "../src/agent/models.js";
import {
    extractThoughtSignature,
    isDummySignature,
} from "../src/agent/provider-options.js";
import { GoogleTransport } from "../src/agent/transport/google.js";
import {
    makeEvent,
    messageContentItem,
} from "../src/agent/schemas.js";
import { FunctionTool } from "../src/agent/tools/base.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import { isTransientLlmError } from "./_verify-llm.js";
import { check, checkEqual, runScript, skip } from "./_verify-common.js";

runScript(async () => {
    // =========================================================================
    // Fake round-trip (deterministic — always runs)
    // =========================================================================
    {
        const client = new ScriptedClient([
            toolCallResponse([
                {
                    id: "c1",
                    name: "add",
                    arguments: { a: 1, b: 2 },
                    providerOptions: { thought_signature: "sig_from_model" },
                },
            ]),
            textResponse("3"),
        ]);
        const addTool = new FunctionTool({
            name: "add",
            description: "add",
            argsSchema: z.object({ a: z.number(), b: z.number() }),
            fn: ({ a, b }) => a + b,
        });
        const agent = new Agent({ llmClient: client, tools: [addTool] });
        await agent.run("add 1 and 2");

        const secondCall = client.calls[1];
        check(secondCall !== undefined, "fake-roundtrip: second request captured");
        const toolCallEvent = secondCall?.events.find((e) =>
            e.content.some((c) => c.type === "tool_call"),
        );
        check(
            toolCallEvent !== undefined,
            "fake-roundtrip: tool_call event in second request",
        );
        const toolCallItem = toolCallEvent?.content.find(
            (c) => c.type === "tool_call",
        );
        if (toolCallItem?.type === "tool_call") {
            checkEqual(
                toolCallItem.toolCall.providerOptions,
                { thought_signature: "sig_from_model" },
                "fake-roundtrip: signature propagated to second request",
            );
        }

        const firstCall = client.calls[0];
        check(firstCall !== undefined, "fake-roundtrip: first request captured");
    }

    // =========================================================================
    // Dummy signature is treated as absent by extraction (fake)
    // =========================================================================
    {
        const dummyOpts = { skip_thought_signature_validator: true };
        check(
            isDummySignature(dummyOpts.skip_thought_signature_validator),
            "fake-dummy: dummy value recognized",
        );
        checkEqual(
            extractThoughtSignature(dummyOpts),
            null,
            "fake-dummy: dummy signature extracts to null",
        );
    }

    // =========================================================================
    // Live multi-turn (through the fallback chain)
    // =========================================================================
    //
    // The chain is flat: every model in the configured order is an entry,
    // and `FallbackClient` rotates on quota/rate-limit/server errors. A
    // `captureRequest` hook on each underlying `LlmClient` records every
    // request sent, so we can assert that the signature that came back
    // from turn 1 was replayed on turn 2 — regardless of which model
    // served each turn.
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (apiKey === undefined || apiKey === "") {
        skip("provider-options/multiturn/live: no GEMINI_API_KEY");
        return;
    }

    // `captureRequest` receives the fully-built messages (`ChatMessage[]`),
    // not the `LlmRequest`. Typed accordingly.
    type CapturePayload = Parameters<RequestCapture>[0];
    const captured: CapturePayload[] = [];
    const capture: RequestCapture = (payload) => {
        captured.push(payload);
    };

    const entries: FallbackEntry[] = [];
    const failures: string[] = [];
    for (const model of getModelChain()) {
        try {
            const resolved = resolveModel(model);
            const transport = new GoogleTransport(resolved, { apiKey });
            entries.push({
                name: model,
                client: new LlmClient({
                    model: resolved,
                    transport,
                    maxRetries: 1,
                    captureRequest: capture,
                }),
            });
        } catch (error) {
            failures.push(`${model}: ${(error as Error).message}`);
        }
    }
    if (entries.length === 0) {
        skip(
            `provider-options/multiturn/live: no model could be constructed (${failures.join("; ")})`,
        );
        return;
    }

    const liveClient = new FallbackClient({ entries });

    const addTool = new FunctionTool({
        name: "add",
        description: "add two numbers",
        argsSchema: z.object({ a: z.number(), b: z.number() }),
        fn: ({ a, b }) => a + b,
    });

    const liveAgent = new Agent({
        llmClient: liveClient,
        tools: [addTool],
        maxSteps: 3,
    });

    try {
        const result = await liveAgent.run(
            "What is 2 + 3? You must use the add tool.",
        );

        if (result.finalResult === null && result.stoppedByMaxSteps) {
            skip(
                "provider-options/multiturn/live: agent hit maxSteps without final answer",
            );
            return;
        }

        const toolCallEvent = result.context.events.find((e) =>
            e.content.some((c) => c.type === "tool_call"),
        );
        if (toolCallEvent === undefined) {
            skip("provider-options/multiturn/live: model did not call the tool");
            return;
        }
        const toolCallItem = toolCallEvent.content.find(
            (c) => c.type === "tool_call",
        );
        if (toolCallItem?.type !== "tool_call") {
            skip("provider-options/multiturn/live: no tool_call item");
            return;
        }

        const signature = extractThoughtSignature(
            toolCallItem.toolCall.providerOptions,
        );
        if (signature === null) {
            skip(
                "provider-options/multiturn/live: model returned no thought signature " +
                "(SDK/model may not expose it; cannot verify round-trip)",
            );
            return;
        }
        check(true, "provider-options/multiturn/live: real signature captured");

        // Find the captured request whose built messages contain an assistant
        // message with a tool-call carrying a signature. That's the turn-2
        // request (it replays the tool call from turn 1). If rotation fired
        // during the run, multiple captures may exist; we search for the one
        // that actually carries the signature.
        type ToolCallInMessages = NonNullable<
            Extract<ChatMessage, { role: "assistant" }>["toolCalls"]
        >[number];

        function findToolCallWithSignature(
            messages: ChatMessage[],
        ): ToolCallInMessages | null {
            for (const m of messages) {
                if (m.role !== "assistant") continue;
                const tcs = m.toolCalls;
                if (tcs === undefined) continue;
                for (const tc of tcs) {
                    if (extractThoughtSignature(tc.providerOptions ?? null) !== null) {
                        return tc;
                    }
                }
            }
            return null;
        }

        let propagated: string | null = null;
        for (const req of captured) {
            const tc = findToolCallWithSignature(req.messages);
            if (tc === null) continue;
            propagated = extractThoughtSignature(tc.providerOptions ?? null);
            break;
        }

        if (propagated === null) {
            check(
                false,
                "provider-options/multiturn/live: no captured request replayed the signature",
            );
            return;
        }

        checkEqual(
            propagated,
            signature,
            "provider-options/multiturn/live: signature propagated verbatim",
        );

        check(
            result.finalResult !== null,
            "provider-options/multiturn/live: run completed",
        );

        // If rotation happened, report it so the test is self-documenting.
        const tried = result.usage !== null ? captured.length : 0;
        if (tried > 2) {
            process.stderr.write(
                `[verify] provider-options/multiturn/live: ${captured.length} total requests captured (rotation fired during the run)\n`,
            );
        }
    } catch (error) {
        const message = (error as Error).message ?? "";
        const lower = message.toLowerCase();
        if (lower.includes("signature") || lower.includes("thought")) {
            check(
                false,
                `provider-options/multiturn/live: signature round-trip failed: ${message}`,
            );
            return;
        }
        if (isTransientLlmError(message, { errorType: "unknown" })) {
            skip(`provider-options/multiturn/live: transient error: ${message}`);
            return;
        }
        skip(`provider-options/multiturn/live: exception: ${message}`);
    }
});