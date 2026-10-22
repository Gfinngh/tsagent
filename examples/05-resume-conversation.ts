/**
 * 05 — Resume conversation
 *
 * Event sourcing: the conversation is a persisted list of events. Run
 * an agent normally, write each event to a JSONL log, rehydrate the
 * context from that log, then call `agent.resume()` with a follow-up
 * message. The resumed run sees the entire prior conversation.
 *
 *   npx tsx examples/05-resume-conversation.ts
 *
 * (Deletes `.examples/resume-*.jsonl` on start; safe to re-run.)
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.js";
import { ExecutionContext } from "../src/agent/context.js";
import { JsonlEventLog } from "../src/agent/event-log.js";
import { buildDefaultFallbackChain } from "../src/agent/runtime.js";
import { ensureDir, loadEnv, printFinal, printTrace } from "./_common.js";

loadEnv();

const EXAMPLES_DIR = ".examples";
const RUN1_LOG = join(EXAMPLES_DIR, "resume-1.jsonl");
const RUN2_LOG = join(EXAMPLES_DIR, "resume-2.jsonl");

async function main(): Promise<void> {
    ensureDir(EXAMPLES_DIR);
    rmSync(RUN1_LOG, { force: true });
    rmSync(RUN2_LOG, { force: true });

    const agent = new Agent({
        llmClient: buildDefaultFallbackChain(),
    });

    // ── Run 1: fresh conversation ────────────────────────────────
    const log1 = new JsonlEventLog(RUN1_LOG, { fsync: true });
    try {
        console.log('→ Say "first" and nothing else.\n');
        const result1 = await agent.run('Say "first" and nothing else.', {
            onEvent: (event) => log1.append(event),
        });
        console.log("--- trace (run 1) ---");
        printTrace(result1);
        console.log("\n--- final answer (run 1) ---");
        printFinal(result1);
    } finally {
        log1.close();
    }

    // ── Rehydrate: recreate the context from the log ────────────
    console.log(`\n--- rehydrating from ${RUN1_LOG} ---`);
    const rehydrated = ExecutionContext.fromLog(RUN1_LOG);
    console.log(
        `rehydrated ${rehydrated.events.length} events, ${rehydrated.currentStep} step(s)`,
    );
    console.log(`already finished: ${rehydrated.isFinished}`);

    // ── Run 2: resume with a follow-up ──────────────────────────
    const log2 = new JsonlEventLog(RUN2_LOG, { fsync: true });
    try {
        console.log('\n→ Resume with: Say "second" and nothing else.\n');
        const result2 = await agent.resume(rehydrated, {
            userMessage: 'Say "second" and nothing else.',
            onEvent: (event) => log2.append(event),
        });
        console.log("--- trace (run 2) ---");
        printTrace(result2);
        console.log("\n--- final answer (run 2) ---");
        printFinal(result2);
        console.log(
            `\ntotal events after resume: ${result2.context.events.length}`,
        );
    } finally {
        log2.close();
    }
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});