/**
 * 08 — Memory
 *
 * SQLite + FTS5 key-value store with keyword search. Demonstrates:
 *   - `upsert` to store
 *   - `search` for FTS keyword lookup
 *   - `list` for enumeration
 *   - `forget` for deletion
 *
 * The four `makeMemoryTools()` wrappers give you the exact interface
 * the agent uses — pass them to `new Agent({ tools: makeMemoryTools(store) })`
 * to let the model remember and recall facts across turns.
 *
 *   npx tsx examples/08-memory.ts
 *
 * (Deletes `.examples/memory.sqlite3` on start; safe to re-run.)
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, makeMemoryTools } from "../src/agent/memory.js";
import { ensureDir, loadEnv } from "./_common.js";

loadEnv();

const EXAMPLES_DIR = ".examples";
const DB_PATH = join(EXAMPLES_DIR, "memory.sqlite3");

async function main(): Promise<void> {
    ensureDir(EXAMPLES_DIR);
    for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${DB_PATH}${suffix}`, { force: true });
    }

    const store = new MemoryStore(DB_PATH);
    console.log(`memory db: ${DB_PATH}`);

    try {
        // ── Store some entries ──────────────────────────────────────
        console.log("\n--- remember ---");
        store.upsert({
            namespace: "facts",
            key: "favorite-color",
            content: "My favorite color is blue.",
            tags: ["user-preference"],
        });
        console.log("  stored: facts/favorite-color");
        store.upsert({
            namespace: "facts",
            key: "home-city",
            content: "I live in Kyoto.",
            tags: ["user-preference"],
        });
        console.log("  stored: facts/home-city");
        store.upsert({
            namespace: "notes",
            key: "todo",
            content: "Read about TypeScript generics this week.",
            tags: ["learning"],
        });
        console.log("  stored: notes/todo");

        // ── Search ──────────────────────────────────────────────────
        console.log('\n--- search("Kyoto") ---');
        const kyoto = store.search("Kyoto");
        for (const row of kyoto) {
            console.log(`  [${row.namespace}] ${row.key}: ${row.content}`);
        }

        console.log('\n--- search("TypeScript") ---');
        const ts = store.search("TypeScript");
        for (const row of ts) {
            console.log(`  [${row.namespace}] ${row.key}: ${row.content}`);
        }

        console.log('\n--- search("preference")  (matches tag) ---');
        const tagged = store.search("preference");
        for (const row of tagged) {
            console.log(`  [${row.namespace}] ${row.key}`);
        }

        // ── List one namespace ──────────────────────────────────────
        console.log('\n--- list("facts") ---');
        for (const row of store.list("facts")) {
            console.log(`  ${row.key}: ${row.content}`);
        }

        // ── Forget ──────────────────────────────────────────────────
        console.log('\n--- forget("notes", "todo") ---');
        const removed = store.forget("notes", "todo");
        console.log(`  removed: ${removed}`);
        console.log(`  remaining in notes: ${store.list("notes").length}`);

        // ── The tools ───────────────────────────────────────────────
        console.log("\n--- available as tools ---");
        for (const tool of makeMemoryTools(store)) {
            console.log(`  ${tool.name.padEnd(15)} [${tool.permission}]`);
        }
        console.log(
            "\nPass these to an Agent to let the model use memory during a conversation.",
        );
    } finally {
        store.close();
    }
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});