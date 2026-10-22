/**
 * 16 — Event log primitives
 *
 * The conversation is a JSONL file, one event per line. `JsonlEventLog`
 * appends atomically; `readEventLog` reads with strict handling of
 * three edge cases:
 *
 *   - blank lines → silently skipped
 *   - unterminated final line (writer crashed mid-write) → warned and
 *     skipped, even if the fragment parses as JSON
 *   - malformed interior line → throws EventLogFormatError with the
 *     exact line number
 *
 * This example writes files by hand to hit every edge case so you can
 * see the behavior directly. No LLM.
 *
 *   npx tsx examples/16-event-log.ts
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    EventLogFormatError,
    JsonlEventLog,
    readEventLog,
} from "../src/agent/event-log.js";
import {
    makeEvent,
    messageContentItem,
} from "../src/agent/schemas.js";
import { ensureDir, loadEnv, section } from "./_common.js";

loadEnv();

const DIR = ".examples/logs";

function ev(text: string) {
    return makeEvent([
        messageContentItem({ role: "assistant", content: text }),
    ]);
}

function check(label: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ✓ ${label}`);
    } catch (error) {
        console.log(
            `  ✗ ${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

async function main(): Promise<void> {
    section("setup");
    rmSync(DIR, { recursive: true, force: true });
    ensureDir(DIR);
    console.log(`logs directory: ${DIR}`);

    section("1. Basic write + read round-trip");
    {
        const path = join(DIR, "basic.jsonl");
        const log = new JsonlEventLog(path, { fsync: true });
        log.append(ev("first"));
        log.append(ev("second"));
        log.close();
        const events = readEventLog(path);
        console.log(`  events: ${events.length}`);
    }

    section("2. Blank lines are skipped");
    {
        const path = join(DIR, "blank.jsonl");
        writeFileSync(
            path,
            JSON.stringify(ev("a")) + "\n\n\n" + JSON.stringify(ev("b")) + "\n",
        );
        const events = readEventLog(path);
        console.log(`  events: ${events.length} (expected 2)`);
    }

    section("3. Truncated final line is warned and skipped");
    {
        const path = join(DIR, "truncated.jsonl");
        writeFileSync(
            path,
            JSON.stringify(ev("a")) + "\n" + '{"id":"partial","time',
        );
        let warned = false;
        const events = readEventLog(path, {
            onTruncatedTail: (p, line, _raw) => {
                warned = true;
                console.log(`  warning fired: ${p} line ${line}`);
            },
        });
        console.log(`  events: ${events.length} (expected 1)`);
        console.log(`  warned: ${warned}`);
    }

    section("4. Malformed interior line throws with line number");
    {
        const path = join(DIR, "malformed.jsonl");
        writeFileSync(
            path,
            JSON.stringify(ev("a")) + "\nnot-json\n" + JSON.stringify(ev("b")) + "\n",
        );
        try {
            readEventLog(path);
            console.log("  unexpected: no error");
        } catch (error) {
            if (error instanceof EventLogFormatError) {
                console.log(`  EventLogFormatError at line ${error.lineNumber}`);
                console.log(`  message: ${error.message}`);
            } else {
                console.log(
                    `  unexpected error type: ${error instanceof Error ? error.name : typeof error}`,
                );
            }
        }
    }

    section("5. Reopen after close (does not truncate the file)");
    {
        const path = join(DIR, "reopen.jsonl");
        const log1 = new JsonlEventLog(path, { fsync: true });
        log1.append(ev("first"));
        log1.close();
        const log2 = new JsonlEventLog(path, { fsync: true });
        log2.append(ev("second"));
        log2.close();
        const events = readEventLog(path);
        console.log(`  events: ${events.length} (expected 2)`);
    }

    section("6. `readEventLog` bounds memory by longest line, not file size");
    {
        // Produce a 2 MB log of normal-length lines to demonstrate that
        // reading does not load the whole file into memory.
        const path = join(DIR, "large.jsonl");
        const log = new JsonlEventLog(path, { fsync: false });
        for (let i = 0; i < 5000; i += 1) {
            log.append(ev(`payload-${i}-${"p".repeat(200)}`));
        }
        log.close();
        const start = Date.now();
        const events = readEventLog(path);
        const elapsed = Date.now() - start;
        console.log(`  events: ${events.length}`);
        console.log(`  read time: ~${elapsed}ms`);
        console.log("  (implementation uses chunked readSync, not readFileSync)");
    }

    section("cleanup");
    rmSync(DIR, { recursive: true, force: true });
    console.log(`removed ${DIR}`);
    check("done", () => { });
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});