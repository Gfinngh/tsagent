/**
 * 17 — Tracing
 *
 * OpenTelemetry facade. Tracing is off by default; `initTracing()`
 * turns it on. When `inMemory: true`, spans are kept in a buffer you
 * can inspect via `inMemorySpans()`. When `otlp: true` (or an OTLP /
 * Langfuse endpoint is configured in env), spans are exported.
 *
 * The `Agent` class emits a span tree on every run:
 *
 *   agent.run
 *   ├── agent.step   (one per loop iteration)
 *   │   └── agent.tool   (one per tool call)
 *   └── ...
 *
 * This example drives a small scripted agent and prints the resulting
 * span tree. No LLM.
 *
 *   npx tsx examples/17-tracing.ts
 */

import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import { FunctionTool } from "../src/agent/tools/base.js";
import {
    initTracing,
    shutdownTracing,
    inMemorySpans,
    type InMemorySpan,
} from "../src/agent/tracing.js";
import { section } from "./_common.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_fakes.js";

function printSpanTree(spans: readonly InMemorySpan[]): void {
    const byParent = new Map<string | null, InMemorySpan[]>();
    for (const span of spans) {
        const list = byParent.get(span.parentSpanId) ?? [];
        list.push(span);
        byParent.set(span.parentSpanId, list);
    }

    function walk(parentId: string | null, depth: number): void {
        const children = byParent.get(parentId) ?? [];
        // Stable order: earlier starts first.
        children.sort((a, b) => a.startTimeMs - b.startTimeMs);
        for (const span of children) {
            const indent = "  ".repeat(depth);
            const dur = (span.endTimeMs - span.startTimeMs).toFixed(1);
            const attrs = Object.entries(span.attributes)
                .slice(0, 3)
                .map(([k, v]) => `${k}=${String(v)}`)
                .join(" ");
            console.log(`${indent}${span.name} (${dur}ms)  ${attrs}`);
            walk(span.spanId, depth + 1);
        }
    }

    // Roots have null parentSpanId.
    walk(null, 0);
}

async function main(): Promise<void> {
    await shutdownTracing(); // clean slate
    initTracing({ inMemory: true, otlp: false });

    section("agent run with tracing enabled");

    const addTool = new FunctionTool({
        name: "add",
        description: "Adds two numbers.",
        argsSchema: z.object({ a: z.number(), b: z.number() }),
        fn: ({ a, b }) => a + b,
    });

    const client = new ScriptedClient([
        toolCallResponse([makeToolCall("c1", "add", { a: 2, b: 3 })]),
        textResponse("The answer is 5."),
    ]);

    const agent = new Agent({
        llmClient: client,
        tools: [addTool],
    });
    await agent.run("add 2 and 3");

    section("span tree");
    const spans = inMemorySpans();
    printSpanTree(spans);
    console.log(`\ntotal spans: ${spans.length}`);

    section("captured events");
    for (const span of spans) {
        for (const event of span.events) {
            console.log(`  ${span.name}: event "${event.name}"`);
        }
    }

    section("status");
    for (const span of spans) {
        console.log(
            `  ${span.name.padEnd(15)} status=${span.status.code}`,
        );
    }

    section("shutdown");
    await shutdownTracing();
    console.log(`  tracing enabled: false`);
    console.log(
        "  (env vars OTEL_EXPORTER_OTLP_ENDPOINT or LANGFUSE_* would enable export)",
    );
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});