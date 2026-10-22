/**
 * Verification: memory bounds and pruning.
 *
 * Covers:
 *   - `upsert` rejects keys/content/namespaces/tags that exceed the caps
 *   - the tool schemas (via `makeMemoryTools`) reject the same inputs
 *   - `prune(N)` deletes entries older than N days, keeps fresh ones,
 *     returns the deleted count, and updates the FTS index
 *   - auto-prune on open (via `pruneAfterDays` option) and via
 *     `TSAGENT_MEMORY_PRUNE_DAYS`
 *   - `prune(0)` / `prune(-1)` / `prune(NaN)` throw
 *   - `sizeBytes()` reflects on-disk size, `0` for `:memory:`
 *   - `list` and `search` clamp `limit` to the MAX
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, makeMemoryTools } from "../src/agent/memory.js";
import type { BaseTool } from "../src/agent/tools/base.js";
import {
    check,
    checkEqual,
    makeTempDir,
    runScript,
} from "./_verify-common.js";

runScript(async () => {
    const tmp = makeTempDir("memory-bounds");

    try {
        // =====================================================================
        // 1. Bounds — key length
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "bounds-key.sqlite3"));
            const okKey = "a".repeat(256);
            store.upsert({ namespace: "d", key: okKey, content: "ok" });
            check(true, "bounds/key: 256-char key accepted");

            const badKey = "a".repeat(257);
            let threw = false;
            let message = "";
            try {
                store.upsert({ namespace: "d", key: badKey, content: "x" });
            } catch (error) {
                threw = true;
                message = error instanceof Error ? error.message : String(error);
            }
            check(threw, "bounds/key: 257-char key rejected");
            check(
                message.includes("key length"),
                `bounds/key: rejection message mentions key length (got: ${message})`,
            );
            store.close();
        }

        // =====================================================================
        // 2. Bounds — content length
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "bounds-content.sqlite3"));
            const okContent = "x".repeat(64 * 1024);
            store.upsert({ namespace: "d", key: "k", content: okContent });
            check(true, "bounds/content: 64 KiB content accepted");

            const badContent = "x".repeat(64 * 1024 + 1);
            let threw = false;
            try {
                store.upsert({ namespace: "d", key: "k2", content: badContent });
            } catch {
                threw = true;
            }
            check(threw, "bounds/content: 64 KiB + 1 rejected");
            store.close();
        }

        // =====================================================================
        // 3. Bounds — namespace length
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "bounds-ns.sqlite3"));
            store.upsert({
                namespace: "n".repeat(128),
                key: "k",
                content: "ok",
            });
            check(true, "bounds/namespace: 128-char namespace accepted");

            let threw = false;
            try {
                store.upsert({
                    namespace: "n".repeat(129),
                    key: "k2",
                    content: "x",
                });
            } catch {
                threw = true;
            }
            check(threw, "bounds/namespace: 129-char rejected");
            store.close();
        }

        // =====================================================================
        // 4. Bounds — tag length and count
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "bounds-tags.sqlite3"));
            // 32 tags, each 64 chars — at the limit.
            store.upsert({
                namespace: "d",
                key: "ok-tags",
                content: "x",
                tags: Array.from({ length: 32 }, () => "t".repeat(64)),
            });
            check(true, "bounds/tags: 32 tags of 64 chars accepted");

            let threwCount = false;
            try {
                store.upsert({
                    namespace: "d",
                    key: "too-many-tags",
                    content: "x",
                    tags: Array.from({ length: 33 }, () => "t"),
                });
            } catch {
                threwCount = true;
            }
            check(threwCount, "bounds/tags: 33 tags rejected");

            let threwLength = false;
            try {
                store.upsert({
                    namespace: "d",
                    key: "tag-too-long",
                    content: "x",
                    tags: ["t".repeat(65)],
                });
            } catch {
                threwLength = true;
            }
            check(threwLength, "bounds/tags: 65-char tag rejected");
            store.close();
        }

        // =====================================================================
        // 5. Tool schemas reject the same inputs
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "tool-bounds.sqlite3"));
            const tools = makeMemoryTools(store);
            const byName = new Map<string, BaseTool>(tools.map((t) => [t.name, t]));
            const remember = byName.get("remember");
            if (remember === undefined) {
                check(false, "tool-bounds: remember tool present");
                return;
            }

            let threw = false;
            try {
                await remember.run({ key: "a".repeat(257), content: "x" });
            } catch {
                threw = true;
            }
            check(threw, "tool-bounds/remember: 257-char key rejected via schema");

            threw = false;
            try {
                await remember.run({ key: "k", content: "x".repeat(64 * 1024 + 1) });
            } catch {
                threw = true;
            }
            check(threw, "tool-bounds/remember: oversized content rejected via schema");

            // A valid call still works.
            const ok = await remember.run({ key: "k", content: "hello" });
            checkEqual(
                String(ok[0]),
                "remembered default/k",
                "tool-bounds/remember: valid call still works",
            );
            store.close();
        }

        // =====================================================================
        // 6. Tool schema clamps limit
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "tool-limit.sqlite3"));
            const tools = makeMemoryTools(store);
            const byName = new Map<string, BaseTool>(tools.map((t) => [t.name, t]));
            const listTool = byName.get("list_memories");
            if (listTool === undefined) {
                check(false, "tool-limit: list_memories tool present");
                return;
            }

            let threw = false;
            try {
                await listTool.run({ limit: 101 });
            } catch {
                threw = true;
            }
            check(threw, "tool-limit/list: limit 101 rejected via schema");

            // 100 is at the limit.
            const ok = await listTool.run({ namespace: "d", limit: 100 });
            checkEqual(ok.length, 1, "tool-limit/list: limit 100 accepted");
            store.close();
        }

        // =====================================================================
        // 7. prune(0), prune(-1), prune(NaN) throw
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "prune-args.sqlite3"));
            for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
                let threw = false;
                try {
                    store.prune(bad);
                } catch {
                    threw = true;
                }
                check(threw, `prune-args: prune(${String(bad)}) throws`);
            }
            store.close();
        }

        // =====================================================================
        // 8. prune deletes old entries, keeps fresh ones
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "prune.sqlite3"));
            // Insert two entries, then manually backdate one to 60 days ago.
            store.upsert({ namespace: "d", key: "old", content: "ancient wisdom about zebras" });
            store.upsert({ namespace: "d", key: "fresh", content: "current note about zebras" });

            // Reach into the internal DB and backdate `old`. This is a test
            // fixture; no production code should do this.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const internal = (store as unknown as { db: import("better-sqlite3").Database | null }).db;
            if (internal === null) {
                check(false, "prune: internal db not open");
                return;
            }
            const sixtyDaysAgo = Date.now() / 1000 - 60 * 86_400;
            internal
                .prepare(`UPDATE memories SET updated_at = ? WHERE key = 'old'`)
                .run(sixtyDaysAgo);

            const removed = store.prune(30);
            checkEqual(removed, 1, "prune: exactly one row deleted");

            const rows = store.list("d");
            checkEqual(rows.length, 1, "prune: one row remains");
            checkEqual(rows[0]?.key, "fresh", "prune: fresh row kept");

            // FTS index must not return the pruned row.
            const matches = store.search("zebras");
            checkEqual(matches.length, 1, "prune: FTS returns one match");
            checkEqual(matches[0]?.key, "fresh", "prune: FTS match is the fresh row");

            // Second prune is a no-op.
            const removedAgain = store.prune(30);
            checkEqual(removedAgain, 0, "prune: second prune deletes nothing");
            store.close();
        }

        // =====================================================================
        // 9. Auto-prune on open (via pruneAfterDays option)
        // =====================================================================
        {
            const path = join(tmp.path, "auto-prune-opt.sqlite3");
            // First store: insert data and backdate it, then close.
            {
                const seed = new MemoryStore(path);
                seed.upsert({ namespace: "d", key: "ancient", content: "old elephant fact" });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const internal = (seed as unknown as { db: import("better-sqlite3").Database | null }).db;
                if (internal === null) {
                    check(false, "auto-prune/opt: seed db not open");
                    return;
                }
                const cutoff = Date.now() / 1000 - 100 * 86_400;
                internal
                    .prepare(`UPDATE memories SET updated_at = ? WHERE key = 'ancient'`)
                    .run(cutoff);
                seed.close();
            }

            // Second store: auto-prune on open.
            const store = new MemoryStore(path, { pruneAfterDays: 30 });
            // Trigger the open + prune by performing an operation.
            const rows = store.list("d");
            checkEqual(rows.length, 0, "auto-prune/opt: stale entry was pruned on open");
            store.close();
        }

        // =====================================================================
        // 10. Auto-prune via TSAGENT_MEMORY_PRUNE_DAYS env var
        // =====================================================================
        {
            const path = join(tmp.path, "auto-prune-env.sqlite3");
            // Seed without env var set.
            const origEnv = process.env.TSAGENT_MEMORY_PRUNE_DAYS;
            delete process.env.TSAGENT_MEMORY_PRUNE_DAYS;
            {
                const seed = new MemoryStore(path);
                seed.upsert({ namespace: "d", key: "ancient", content: "old giraffe fact" });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const internal = (seed as unknown as { db: import("better-sqlite3").Database | null }).db;
                if (internal === null) {
                    check(false, "auto-prune/env: seed db not open");
                    return;
                }
                const cutoff = Date.now() / 1000 - 100 * 86_400;
                internal
                    .prepare(`UPDATE memories SET updated_at = ? WHERE key = 'ancient'`)
                    .run(cutoff);
                seed.close();
            }

            process.env.TSAGENT_MEMORY_PRUNE_DAYS = "30";
            try {
                const store = new MemoryStore(path);
                const rows = store.list("d");
                checkEqual(
                    rows.length,
                    0,
                    "auto-prune/env: stale entry pruned via env var",
                );
                store.close();
            } finally {
                if (origEnv === undefined) {
                    delete process.env.TSAGENT_MEMORY_PRUNE_DAYS;
                } else {
                    process.env.TSAGENT_MEMORY_PRUNE_DAYS = origEnv;
                }
            }
        }

        // =====================================================================
        // 11. Explicit `pruneAfterDays: null` overrides env var
        // =====================================================================
        {
            const path = join(tmp.path, "auto-prune-override.sqlite3");
            {
                const seed = new MemoryStore(path);
                seed.upsert({ namespace: "d", key: "ancient", content: "old tiger fact" });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const internal = (seed as unknown as { db: import("better-sqlite3").Database | null }).db;
                if (internal === null) {
                    check(false, "auto-prune/override: seed db not open");
                    return;
                }
                const cutoff = Date.now() / 1000 - 100 * 86_400;
                internal
                    .prepare(`UPDATE memories SET updated_at = ? WHERE key = 'ancient'`)
                    .run(cutoff);
                seed.close();
            }

            const origEnv = process.env.TSAGENT_MEMORY_PRUNE_DAYS;
            process.env.TSAGENT_MEMORY_PRUNE_DAYS = "30";
            try {
                const store = new MemoryStore(path, { pruneAfterDays: null });
                const rows = store.list("d");
                checkEqual(
                    rows.length,
                    1,
                    "auto-prune/override: explicit null disables pruning",
                );
                checkEqual(
                    rows[0]?.key,
                    "ancient",
                    "auto-prune/override: the ancient entry survived",
                );
                store.close();
            } finally {
                if (origEnv === undefined) {
                    delete process.env.TSAGENT_MEMORY_PRUNE_DAYS;
                } else {
                    process.env.TSAGENT_MEMORY_PRUNE_DAYS = origEnv;
                }
            }
        }

        // =====================================================================
        // 12. Invalid env var is ignored
        // =====================================================================
        {
            const path = join(tmp.path, "auto-prune-garbage-env.sqlite3");
            const origEnv = process.env.TSAGENT_MEMORY_PRUNE_DAYS;
            process.env.TSAGENT_MEMORY_PRUNE_DAYS = "not-a-number";
            try {
                const store = new MemoryStore(path);
                store.upsert({ namespace: "d", key: "k", content: "content" });
                check(true, "auto-prune/garbage-env: store opens cleanly");
                const rows = store.list("d");
                checkEqual(rows.length, 1, "auto-prune/garbage-env: no pruning occurred");
                store.close();
            } finally {
                if (origEnv === undefined) {
                    delete process.env.TSAGENT_MEMORY_PRUNE_DAYS;
                } else {
                    process.env.TSAGENT_MEMORY_PRUNE_DAYS = origEnv;
                }
            }
        }

        // =====================================================================
        // 13. sizeBytes
        // =====================================================================
        {
            const memStore = new MemoryStore(":memory:");
            checkEqual(memStore.sizeBytes(), 0, "sizeBytes: :memory: returns 0");
            memStore.upsert({ namespace: "d", key: "k", content: "x" });
            checkEqual(memStore.sizeBytes(), 0, "sizeBytes: :memory: stays 0 after writes");
            memStore.close();

            const filePath = join(tmp.path, "size.sqlite3");
            check(!existsSync(filePath), "sizeBytes: file absent before open");
            const fileStore = new MemoryStore(filePath);
            fileStore.upsert({ namespace: "d", key: "k", content: "x".repeat(1000) });
            check(
                fileStore.sizeBytes() > 0,
                `sizeBytes: file has nonzero size (${fileStore.sizeBytes()})`,
            );
            fileStore.close();
        }
    } finally {
        // Cleanup
        try {
            rmSync(tmp.path, { recursive: true, force: true });
        } catch {
            // ignore
        }
    }
});