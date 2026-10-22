import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import { FunctionTool } from "../src/agent/tools/base.js";
import {
    initTracing,
    inMemorySpans,
    isTracingEnabled,
    resolveOtlpEndpoint,
    resolveOtlpHeaders,
    shutdownTracing,
    span,
    withSpan,
    type InMemorySpan,
} from "../src/agent/tracing.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import { check, checkEqual, checkSoft, runScript } from "./_verify-common.js";

async function withFreshTracing(
    fn: () => Promise<void> | void,
): Promise<void> {
    await shutdownTracing();
    initTracing({ inMemory: true, otlp: false });
    try {
        await fn();
    } finally {
        await shutdownTracing();
    }
}

runScript(async () => {
    // =========================================================================
    // 1. No-op before init
    // =========================================================================
    {
        await shutdownTracing(); // ensure clean state
        checkEqual(isTracingEnabled(), false, "pre-init: disabled");

        const s = span("orphan");
        s.setAttribute("k", "v");
        s.recordException(new Error("x"));
        s.setStatus("error", "boom");
        s.end();
        check(true, "pre-init: span() returns no-op that does not throw");

        await withSpan("orphan-with", async () => "value");
        check(true, "pre-init: withSpan() runs fn and returns value");

        checkEqual(inMemorySpans().length, 0, "pre-init: inMemorySpans is empty");
    }

    // =========================================================================
    // 2. initTracing enables tracing
    // =========================================================================
    {
        await shutdownTracing();
        initTracing({ inMemory: true, otlp: false });
        checkEqual(isTracingEnabled(), true, "init: enabled");

        // Idempotent: second call is a no-op.
        initTracing({ inMemory: true, otlp: false });
        checkEqual(isTracingEnabled(), true, "init: idempotent");

        await shutdownTracing();
        checkEqual(isTracingEnabled(), false, "init: shutdown disables");
    }

    // =========================================================================
    // 3. Basic span records name and attributes
    // =========================================================================
    await withFreshTracing(async () => {
        const s = span("basic", {
            "test.key": "value",
            "test.count": 42,
            "test.flag": true,
        });
        s.setAttribute("late.attr", "added");
        s.end();

        const spans = inMemorySpans();
        checkEqual(spans.length, 1, "basic: one span recorded");
        const recorded = spans[0]!;
        checkEqual(recorded.name, "basic", "basic: name");
        checkEqual(recorded.attributes["test.key"], "value", "basic: string attr");
        checkEqual(recorded.attributes["test.count"], 42, "basic: number attr");
        checkEqual(recorded.attributes["test.flag"], true, "basic: boolean attr");
        checkEqual(recorded.attributes["late.attr"], "added", "basic: late attr");
        checkEqual(recorded.status.code, "unset", "basic: status unset");
    });

    // =========================================================================
    // 4. withSpan: success
    // =========================================================================
    await withFreshTracing(async () => {
        const result = await withSpan(
            "compute",
            async (s) => {
                s.setAttribute("computed", 7);
                return 42;
            },
            { "input.arg": "x" },
        );
        checkEqual(result, 42, "withSpan/success: returns fn's value");

        const spans = inMemorySpans();
        checkEqual(spans.length, 1, "withSpan/success: one span");
        checkEqual(spans[0]?.name, "compute", "withSpan/success: name");
        checkEqual(spans[0]?.attributes["input.arg"], "x", "withSpan/success: initial attr");
        checkEqual(spans[0]?.attributes["computed"], 7, "withSpan/success: fn-set attr");
        checkEqual(spans[0]?.status.code, "unset", "withSpan/success: status unset");
    });

    // =========================================================================
    // 5. withSpan: exception recorded
    // =========================================================================
    await withFreshTracing(async () => {
        let threw = false;
        try {
            await withSpan("explode", async () => {
                throw new Error("kaboom");
            });
        } catch (error) {
            threw = error instanceof Error && error.message === "kaboom";
        }
        check(threw, "withSpan/throw: re-throws");

        const spans = inMemorySpans();
        checkEqual(spans.length, 1, "withSpan/throw: one span");
        checkEqual(spans[0]?.status.code, "error", "withSpan/throw: ERROR status");
        checkEqual(
            spans[0]?.status.message,
            "kaboom",
            "withSpan/throw: status message",
        );
        const exceptionEvent = spans[0]?.events.find(
            (e) => e.name === "exception",
        );
        check(
            exceptionEvent !== undefined,
            "withSpan/throw: exception event recorded",
        );
        check(
            exceptionEvent?.attributes?.["exception.message"] === "kaboom",
            "withSpan/throw: exception message attribute",
        );
    });

    // =========================================================================
    // 6. Nested withSpan: parent-child
    // =========================================================================
    await withFreshTracing(async () => {
        await withSpan("parent", async () => {
            await withSpan("child-1", async () => {
                await withSpan("grandchild", async () => undefined);
            });
            await withSpan("child-2", async () => undefined);
        });

        const spans = inMemorySpans();
        checkEqual(spans.length, 4, "nested: four spans total");

        const parent = spans.find((s) => s.name === "parent")!;
        const child1 = spans.find((s) => s.name === "child-1")!;
        const child2 = spans.find((s) => s.name === "child-2")!;
        const grandchild = spans.find((s) => s.name === "grandchild")!;

        checkEqual(parent.parentSpanId, null, "nested: parent has no parent");
        checkEqual(
            child1.parentSpanId,
            parent.spanId,
            "nested: child-1 parent is parent",
        );
        checkEqual(
            child2.parentSpanId,
            parent.spanId,
            "nested: child-2 parent is parent",
        );
        checkEqual(
            grandchild.parentSpanId,
            child1.spanId,
            "nested: grandchild parent is child-1",
        );

        // All spans share a trace ID.
        const traceIds = new Set(spans.map((s) => s.traceId));
        checkEqual(traceIds.size, 1, "nested: same trace ID");
    });

    // =========================================================================
    // 7. Manual span in withSpan: still parented correctly
    // =========================================================================
    await withFreshTracing(async () => {
        await withSpan("outer", async () => {
            const inner = span("inner-manual");
            inner.end();
        });

        const spans = inMemorySpans();
        const outer = spans.find((s) => s.name === "outer")!;
        const inner = spans.find((s) => s.name === "inner-manual")!;
        checkEqual(
            inner.parentSpanId,
            outer.spanId,
            "manual: manual span parented to enclosing withSpan",
        );
    });

    // =========================================================================
    // 8. Agent instrumentation
    // =========================================================================
    await withFreshTracing(async () => {
        const addTool = new FunctionTool({
            name: "add",
            description: "add",
            argsSchema: z.object({ a: z.number(), b: z.number() }),
            fn: ({ a, b }) => a + b,
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "add", { a: 2, b: 3 })]),
            textResponse("5"),
        ]);
        const agent = new Agent({ llmClient: client, tools: [addTool] });
        await agent.run("add 2 and 3");

        const spans = inMemorySpans();
        const runSpans = spans.filter((s) => s.name === "agent.run");
        const stepSpans = spans.filter((s) => s.name === "agent.step");
        const toolSpans = spans.filter((s) => s.name === "agent.tool");

        checkEqual(runSpans.length, 1, "agent: one agent.run");
        checkEqual(stepSpans.length, 2, "agent: two agent.step");
        checkEqual(toolSpans.length, 1, "agent: one agent.tool");

        const run = runSpans[0]!;
        checkEqual(run.parentSpanId, null, "agent: agent.run is root");
        checkEqual(
            run.attributes["agent.max_steps"],
            10,
            "agent: agent.run.max_steps",
        );
        checkEqual(
            run.attributes["agent.structured"],
            false,
            "agent: agent.run.structured=false",
        );
        checkEqual(
            run.attributes["agent.final_result_kind"],
            "text",
            "agent: agent.run.final_result_kind=text",
        );
        checkEqual(
            run.attributes["agent.user_message_length"],
            11,
            "agent: agent.run.user_message_length",
        );

        // Every step span's parent is the run span.
        for (const step of stepSpans) {
            checkEqual(
                step.parentSpanId,
                run.spanId,
                `agent: step '${String(step.attributes["agent.step_index"])}' parent is run`,
            );
        }

        // The step indices are 0 and 1.
        const stepIndices = stepSpans
            .map((s) => s.attributes["agent.step_index"])
            .sort();
        checkEqual(stepIndices, [0, 1], "agent: step indices 0 and 1");

        // Tool span's parent is the step span it belongs to (step index 0).
        const step0 = stepSpans.find((s) => s.attributes["agent.step_index"] === 0)!;
        const tool = toolSpans[0]!;
        checkEqual(
            tool.parentSpanId,
            step0.spanId,
            "agent: tool parent is step 0",
        );
        checkEqual(
            tool.attributes["agent.tool.name"],
            "add",
            "agent: tool.name",
        );
        checkEqual(
            tool.attributes["agent.tool.permission"],
            "read",
            "agent: tool.permission",
        );
        checkEqual(
            tool.status.code,
            "unset",
            "agent: tool status unset (success)",
        );
    });

    // =========================================================================
    // 9. Agent tool error sets ERROR status on tool span
    // =========================================================================
    await withFreshTracing(async () => {
        const failTool = new FunctionTool({
            name: "fail",
            description: "always fails",
            argsSchema: z.object({}),
            fn: () => {
                throw new Error("tool failed");
            },
        });
        const client = new ScriptedClient([
            toolCallResponse([makeToolCall("c1", "fail")]),
            textResponse("done"),
        ]);
        const agent = new Agent({ llmClient: client, tools: [failTool] });
        await agent.run("go");

        const toolSpan = inMemorySpans().find((s) => s.name === "agent.tool")!;
        checkEqual(toolSpan.status.code, "error", "agent/tool-error: ERROR status");
        checkEqual(
            toolSpan.status.message,
            "tool failed",
            "agent/tool-error: message",
        );
    });

    // =========================================================================
    // 10. Resume instrumentation
    // =========================================================================
    await withFreshTracing(async () => {
        const client = new ScriptedClient([textResponse("reply")]);
        const agent = new Agent({ llmClient: client });

        // Build a context that ends with a pending final (user -> assistant text
        // would be complete; make one with a tool result but no assistant text).
        const { ExecutionContext } = await import("../src/agent/context.js");
        const {
            makeEvent,
            messageContentItem,
            toolCallContentItem,
            toolResultContentItem,
        } = await import("../src/agent/schemas.js");
        const ctx = new ExecutionContext([]);
        ctx.addEvent(makeEvent([messageContentItem({ role: "user", content: "hi" })]));
        ctx.addEvent(
            makeEvent([
                messageContentItem({ role: "assistant", content: null }),
                toolCallContentItem({
                    id: "c1",
                    name: "x",
                    arguments: {},
                    providerOptions: null,
                }),
            ]),
        );
        ctx.addEvent(
            makeEvent([
                toolResultContentItem({
                    toolCallId: "c1",
                    name: "x",
                    content: ["ok"],
                    status: "success",
                }),
            ]),
        );

        await agent.resume(ctx);

        const resumeSpan = inMemorySpans().find((s) => s.name === "agent.resume");
        check(resumeSpan !== undefined, "resume: agent.resume span recorded");
        checkEqual(
            resumeSpan?.attributes["agent.resume_state"],
            "pendingFinal",
            "resume: state is pendingFinal",
        );
    });

    // =========================================================================
    // 11. shutdownTracing returns to no-op
    // =========================================================================
    {
        await shutdownTracing();
        checkEqual(isTracingEnabled(), false, "post-shutdown: disabled");
        checkEqual(inMemorySpans().length, 0, "post-shutdown: inMemorySpans empty");

        const s = span("after");
        s.end();
        check(true, "post-shutdown: span() is no-op");

        await shutdownTracing(); // idempotent
        check(true, "post-shutdown: shutdown is idempotent");
    }

    // =========================================================================
    // 12. Re-init after shutdown works
    // =========================================================================
    {
        initTracing({ inMemory: true, otlp: false });
        checkEqual(isTracingEnabled(), true, "re-init: enabled");

        const s = span("reinit");
        s.setAttribute("v", 1);
        s.end();

        const spans = inMemorySpans();
        checkEqual(spans.length, 1, "re-init: one span after re-init");
        checkEqual(spans[0]?.name, "reinit", "re-init: span recorded cleanly");

        await shutdownTracing();
    }

    // =========================================================================
    // 13. resolveOtlpEndpoint (env-var driven, no network)
    // =========================================================================
    {
        checkEqual(
            resolveOtlpEndpoint({}),
            null,
            "endpoint/empty: null when nothing is set",
        );

        checkEqual(
            resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.local:4318" }),
            "http://otel.local:4318/v1/traces",
            "endpoint/otel: appends /v1/traces",
        );

        checkEqual(
            resolveOtlpEndpoint({
                OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.local:4318/v1/traces",
            }),
            "http://otel.local:4318/v1/traces",
            "endpoint/otel-v1: preserves existing /v1/traces",
        );

        checkEqual(
            resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.local:4318/" }),
            "http://otel.local:4318/v1/traces",
            "endpoint/otel-slash: strips trailing slash",
        );

        checkEqual(
            resolveOtlpEndpoint({
                LANGFUSE_HOST: "https://cloud.langfuse.com",
                LANGFUSE_PUBLIC_KEY: "pk",
                LANGFUSE_SECRET_KEY: "sk",
            }),
            "https://cloud.langfuse.com/api/public/otel/v1/traces",
            "endpoint/langfuse: derives OTLP URL",
        );

        checkEqual(
            resolveOtlpEndpoint({
                LANGFUSE_HOST: "https://cloud.langfuse.com",
                LANGFUSE_PUBLIC_KEY: "pk",
                // missing secret
            }),
            null,
            "endpoint/langfuse-partial: null when secret missing",
        );

        // Explicit endpoint wins over Langfuse.
        checkEqual(
            resolveOtlpEndpoint({
                OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.local:4318",
                LANGFUSE_HOST: "https://cloud.langfuse.com",
                LANGFUSE_PUBLIC_KEY: "pk",
                LANGFUSE_SECRET_KEY: "sk",
            }),
            "http://otel.local:4318/v1/traces",
            "endpoint/precedence: OTEL_EXPORTER_OTLP_ENDPOINT wins",
        );
    }

    // =========================================================================
    // 14. resolveOtlpHeaders
    // =========================================================================
    {
        checkEqual(resolveOtlpHeaders({}), {}, "headers/empty: {}");

        checkEqual(
            resolveOtlpHeaders({ OTEL_EXPORTER_OTLP_HEADERS: "x=a,y=b" }),
            { x: "a", y: "b" },
            "headers/otel: parses comma-separated pairs",
        );

        checkEqual(
            resolveOtlpHeaders({ OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer abc==,x=y" }),
            { authorization: "Bearer abc==", x: "y" },
            "headers/otel-equals: preserves = in values",
        );

        const langfuseHeaders = resolveOtlpHeaders({
            LANGFUSE_PUBLIC_KEY: "pk",
            LANGFUSE_SECRET_KEY: "sk",
        });
        checkEqual(
            langfuseHeaders.Authorization,
            `Basic ${Buffer.from("pk:sk").toString("base64")}`,
            "headers/langfuse: Basic auth from credentials",
        );

        // Explicit headers win over Langfuse.
        const explicitWins = resolveOtlpHeaders({
            OTEL_EXPORTER_OTLP_HEADERS: "x=y",
            LANGFUSE_PUBLIC_KEY: "pk",
            LANGFUSE_SECRET_KEY: "sk",
        });
        checkEqual(
            explicitWins,
            { x: "y" },
            "headers/precedence: OTEL_EXPORTER_OTLP_HEADERS wins",
        );
    }

    // =========================================================================
    // 15. Sanity: inMemorySpans returns a readonly array
    // =========================================================================
    await withFreshTracing(async () => {
        const s = span("sanity");
        s.end();
        const spans = inMemorySpans();
        checkEqual(spans.length, 1, "sanity: one span");
        // Readonly — assignment should fail at type level, but we can still
        // confirm the array's elements have the expected shape.
        const sample: InMemorySpan = spans[0]!;
        check(typeof sample.name === "string", "sanity: sample.name is string");
        check(typeof sample.spanId === "string", "sanity: sample.spanId is string");
        check(
            sample.parentSpanId === null || typeof sample.parentSpanId === "string",
            "sanity: parentSpanId is null or string",
        );
    });

    checkSoft(true, "tracing: all blocks completed");
});