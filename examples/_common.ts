/**
 * Shared helpers for the examples. No test infrastructure here — these
 * are display and setup utilities only.
 */

import { config as dotenvConfig } from "dotenv";
import { mkdirSync } from "node:fs";
import type { AgentResult } from "../src/agent/agent.js";
import type { ToolResult } from "../src/agent/schemas.js";

/**
 * Load `.env` into `process.env`. Call this at the top of any example
 * that will touch the LLM.
 */
export function loadEnv(): void {
    dotenvConfig();
}

/**
 * Create a directory (recursively) if it does not already exist.
 */
export function ensureDir(path: string): void {
    mkdirSync(path, { recursive: true });
}

/**
 * Print a section header. Simple visual separation for multi-step
 * examples.
 */
export function section(title: string): void {
    console.log(`\n=== ${title} ===`);
}

/**
 * Print every event from an agent run in a compact, human-readable
 * trace. Shows user/assistant turns and tool calls/results as they
 * occurred. `errorKind` is appended to tool-result lines when present
 * and not null, so permission denials and timeouts are visible.
 */
export function printTrace(result: AgentResult): void {
    for (const event of result.context.events) {
        for (const item of event.content) {
            if (item.type === "message") {
                const role = item.message.role;
                if (item.message.content === null) continue;
                const prefix = role === "user" ? "→" : role === "assistant" ? "←" : "·";
                console.log(`${prefix} ${item.message.content}`);
            } else if (item.type === "tool_call") {
                console.log(
                    `  ↪ ${item.toolCall.name}(${JSON.stringify(item.toolCall.arguments)})`,
                );
            } else if (item.type === "tool_result") {
                const flat = item.toolResult.content
                    .map((c) => (typeof c === "string" ? c : JSON.stringify(c)))
                    .join(" | ");
                const kindSuffix =
                    item.toolResult.errorKind !== null
                        ? ` [${item.toolResult.errorKind}]`
                        : "";
                console.log(`  ↪ result: ${flat}${kindSuffix}`);
            }
        }
    }
}

/**
 * Print the final result of an agent run: text or pretty-printed
 * structured output. Handles the "no final result" case cleanly.
 */
export function printFinal(result: AgentResult): void {
    if (result.finalResult === null) {
        if (result.stoppedByMaxSteps) {
            console.log("(no final result — hit maxSteps)");
        } else {
            console.log("(no final result)");
        }
        return;
    }
    if (result.finalResult.kind === "text") {
        console.log(result.finalResult.text);
    } else {
        console.log(JSON.stringify(result.finalResult.output, null, 2));
    }
}

/**
 * Collect every `ToolResult` from an agent run, in emission order.
 * Useful when the reader wants to inspect the result independently of
 * the trace.
 */
export function collectToolResults(result: AgentResult): ToolResult[] {
    const out: ToolResult[] = [];
    for (const event of result.context.events) {
        for (const item of event.content) {
            if (item.type === "tool_result") out.push(item.toolResult);
        }
    }
    return out;
}