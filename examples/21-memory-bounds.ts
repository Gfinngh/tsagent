/**
 * 21 — Memory bounds and pruning
 *
 * Memory rows have hard size caps (key, content, tags) enforced both
 * at the tool boundary (zod `.max()`) and again inside `MemoryStore`
 * (defense in depth). `prune(N)` deletes rows older than N days; it
 * can be invoked manually or automatically on store open via
 * `TSAGENT_MEMORY_PRUNE_DAYS` or the `pruneAfterDays` constructor
 * option. `sizeBytes()` reports on-disk size (`0` for `:memory:`).
 *
 * This example exercises all of it directly. No LLM.
 *
 *   npx tsx examples/21-memory-bounds.ts
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../src/agent/memory.js";
import { ensureDir, section } from "./_common.js";

const DIR = ".examples/memory-bounds";
const DB = join(DIR, "memory.sqlite3");

function tryUpsert(
    store: MemoryStore,
    input: { namespace: string; key: string; content: string; tags?: string[] },
    label: string,
): void {
    try {
        store.upsert(input);
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
    const store = new MemoryStore(DB);
    console.log(`db: ${DB}`);

    section("1. sizeBytes before any writes");
    store.upsert({ namespace: "d", key: "k", content: "x" });
    console.log(`  sizeBytes: ${store.sizeBytes()}`);

    section("2. bounds — key length");
    tryUpsert(store, { namespace: "d", key: "k".repeat(256), content: "ok" }, "256-char key");
    tryUpsert(
        store,
        { namespace: "d", key: "k".repeat(257), content: "ok" },
        "257-char key (should fail)",
    );

    section("3. bounds — content length");
    tryUpsert(
        store,
        { namespace: "d", key: "big-ok", content: "x".repeat(64 * 1024) },
        "64 KiB content",
    );
    tryUpsert(
        store,
        { namespace: "d", key: "big-bad", content: "x".repeat(64 * 1024 + 1) },
        "64 KiB + 1 (should fail)",
    );

    section("4. bounds — tags");
    tryUpsert(
        store,
        {
            namespace: "d",
            key: "tags-ok",
            content: "x",
            tags: Array.from({ length: 32 }, () => "t"),
        },
        "32 tags",
    );
    tryUpsert(
        store,
        {
            namespace: "d",
            key: "tags-bad",
            content: "x",
            tags: Array.from({ length: 33 }, () => "t"),
        },
        "33 tags (should fail)",
    );

    section("5. prune(N) — delete rows older than N days");
    {
        store.upsert({ namespace: "old", key: "ancient", content: "old fact" });
        store.upsert({ namespace: "old", key: "recent", content: "new fact" });
        // Backdate the "ancient" row for this demo. Production code never
        // reaches into the DB like this — it is only to make the demo
        // deterministic.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const internal = (store as unknown as { db: unknown }).db as
            | { prepare: (sql: string) => { run: (v: number) => void } }
            | null;
        if (internal !== null) {
            const sixtyDaysAgo = Date.now() / 1000 - 60 * 86_400;
            internal
                .prepare("UPDATE memories SET updated_at = ? WHERE key = 'ancient'")
                .run(sixtyDaysAgo);
        }
        console.log(`  before prune: ${store.list("old").length} rows`);
        const removed = store.prune(30);
        console.log(`  removed: ${removed}`);
        console.log(`  after prune:  ${store.list("old").length} rows`);
        console.log(`  remaining:    ${store.list("old").map((r) => r.key).join(", ")}`);
    }

    section("6. prune(0) rejects (would delete everything)");
    try {
        store.prune(0);
        console.log("  ✗ unexpectedly allowed");
    } catch (error) {
        console.log(
            `  ✓ rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    store.close();

    section("7. auto-prune on open via env var");
    {
        // Prepare a fresh store with one ancient row.
        const autoDb = join(DIR, "auto.sqlite3");
        const seed = new MemoryStore(autoDb);
        seed.upsert({ namespace: "d", key: "ancient", content: "old" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const internal = (seed as unknown as { db: unknown }).db as
            | { prepare: (sql: string) => { run: (v: number) => void } }
            | null;
        if (internal !== null) {
            internal
                .prepare("UPDATE memories SET updated_at = ? WHERE key = 'ancient'")
                .run(Date.now() / 1000 - 100 * 86_400);
        }
        seed.close();

        const prev = process.env.TSAGENT_MEMORY_PRUNE_DAYS;
        process.env.TSAGENT_MEMORY_PRUNE_DAYS = "30";
        try {
            const auto = new MemoryStore(autoDb);
            const rows = auto.list("d");
            console.log(`  rows after auto-prune: ${rows.length} (expected 0)`);
            auto.close();
        } finally {
            if (prev === undefined) {
                delete process.env.TSAGENT_MEMORY_PRUNE_DAYS;
            } else {
                process.env.TSAGENT_MEMORY_PRUNE_DAYS = prev;
            }
        }
    }

    section("cleanup");
    rmSync(DIR, { recursive: true, force: true });
    console.log(`removed ${DIR}`);
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});