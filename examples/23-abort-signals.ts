/**
 * 23 — Abort signals
 *
 * `mergeSignals(a, b)` combines two `AbortSignal`s into one that aborts
 * when either does. `makeAbortError()` produces a canonically-shaped
 * `AbortError` (`err.name === "AbortError"`) used by the agent's
 * cancellation path. This matters because outer cancellation
 * (`SIGINT`, caller signal) must always be distinguishable from
 * internal timeouts — different cleanups, different exit codes.
 *
 * Pure local demo. No LLM.
 *
 *   npx tsx examples/23-abort-signals.ts
 */

import {
    isAbortError,
    makeAbortError,
    mergeSignals,
} from "../src/agent/signals.js";
import { section } from "./_common.js";

function describe(signal: AbortSignal): string {
    return signal.aborted
        ? `aborted (reason: ${String(signal.reason)})`
        : "not aborted";
}

async function main(): Promise<void> {
    section("1. mergeSignals — either input aborts the merged signal");
    {
        const a = new AbortController();
        const b = new AbortController();
        const merged = mergeSignals(a.signal, b.signal);
        console.log(`  before abort: ${describe(merged)}`);
        b.abort("reason-b");
        // Node fires the abort listener synchronously, but a tick lets
        // queued listeners run in the face of implementation differences.
        await new Promise((r) => setImmediate(r));
        console.log(`  after b.abort: ${describe(merged)}`);
        void a;
    }

    section("2. merging an already-aborted signal aborts immediately");
    {
        const a = new AbortController();
        a.abort("pre-aborted");
        const b = new AbortController();
        const merged = mergeSignals(a.signal, b.signal);
        await new Promise((r) => setImmediate(r));
        console.log(`  merged: ${describe(merged)}`);
    }

    section("3. makeAbortError — canonical shape");
    {
        const err = makeAbortError();
        console.log(`  name:    ${err.name}`);
        console.log(`  message: ${err.message}`);
        console.log(`  isAbortError: ${isAbortError(err)}`);
    }

    section("4. isAbortError is strict");
    {
        const cases = [
            ["real AbortError", makeAbortError()],
            ["generic Error", new Error("boom")],
            ["TypeError", new TypeError("x")],
            ["string", "AbortError"],
            ["null", null],
        ] as const;
        for (const [label, value] of cases) {
            console.log(`  ${label.padEnd(18)} → ${isAbortError(value)}`);
        }
    }

    section("5. abort propagation through an awaited tool");
    {
        const controller = new AbortController();

        const work = new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => resolve("work finished"), 10_000);
            controller.signal.addEventListener(
                "abort",
                () => {
                    clearTimeout(timer);
                    reject(makeAbortError());
                },
                { once: true },
            );
        });

        // Simulate a caller interrupting after 20 ms.
        setTimeout(() => controller.abort("caller cancelled"), 20);

        try {
            await work;
            console.log("  ✗ work should not have completed");
        } catch (error) {
            console.log(`  ✓ rejected: ${isAbortError(error) ? "AbortError" : "other error"}`);
            console.log(
                `  reason:   ${String((error as Error).message)}`,
            );
        }
    }

    section("where this matters");
    console.log("Agent.run observes its `signal` and throws CancelledError");
    console.log("when the signal aborts. The CLI wires SIGINT to the same");
    console.log("mechanism (see main.ts), so Ctrl+C cancels the run and");
    console.log("cleanup runs through every `finally` block.");
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});