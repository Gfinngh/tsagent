import { existsSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.js";
import {
    MemoryStore,
    makeMemoryTools,
    sanitizeFts,
} from "../src/agent/memory.js";
import type { BaseTool } from "../src/agent/tools/base.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import {
    check,
    checkEqual,
    checkSoft,
    makeTempDir,
    runScript,
} from "./_verify-common.js";

runScript(async () => {
    const tmp = makeTempDir("memory");

    try {
        // =====================================================================
        // 1. sanitizeFts
        // =====================================================================
        checkEqual(sanitizeFts("hello"), '"hello"', "sanitize: single term");
        checkEqual(
            sanitizeFts("hello world"),
            '"hello" "world"',
            "sanitize: two terms",
        );
        checkEqual(
            sanitizeFts("  hello   world  "),
            '"hello" "world"',
            "sanitize: collapses whitespace",
        );
        checkEqual(
            sanitizeFts('say "hi"'),
            '"say" """hi"""',
            "sanitize: doubles embedded quotes",
        );
        checkEqual(sanitizeFts(""), null, "sanitize: empty -> null");
        checkEqual(sanitizeFts("   "), null, "sanitize: whitespace-only -> null");

        // =====================================================================
        // 2. Lazy open
        // =====================================================================
        const lazyPath = join(tmp.path, "lazy.sqlite3");
        check(!existsSync(lazyPath), "lazy: file does not exist before any operation");
        const lazyStore = new MemoryStore(lazyPath);
        check(!existsSync(lazyPath), "lazy: file still absent after construction");
        checkEqual(lazyStore.isOpen, false, "lazy: not open after construction");
        lazyStore.upsert({ namespace: "n", key: "k", content: "c" });
        check(existsSync(lazyPath), "lazy: file created on first operation");
        checkEqual(lazyStore.isOpen, true, "lazy: open after first operation");
        lazyStore.close();
        checkEqual(lazyStore.isOpen, false, "lazy: not open after close");
        lazyStore.close(); // idempotent
        check(true, "close: idempotent");

        // =====================================================================
        // 3. Persistence across close/reopen
        // =====================================================================
        {
            const persistPath = join(tmp.path, "persist.sqlite3");
            const storeA = new MemoryStore(persistPath);
            storeA.upsert({
                namespace: "notes",
                key: "alpha",
                content: "first entry",
                tags: ["todo"],
            });
            storeA.close();

            const storeB = new MemoryStore(persistPath);
            const rows = storeB.list("notes");
            checkEqual(rows.length, 1, "persist: one row after reopen");
            checkEqual(rows[0]?.key, "alpha", "persist: key preserved");
            checkEqual(rows[0]?.content, "first entry", "persist: content preserved");
            checkEqual(rows[0]?.tags, "todo", "persist: tags preserved");

            // Reopen also re-indexed FTS correctly.
            const searchResults = storeB.search("first");
            checkEqual(searchResults.length, 1, "persist: FTS index rebuilt on reopen");
            storeB.close();
        }

        // =====================================================================
        // 4. Upsert semantics
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "upsert.sqlite3"));
            store.upsert({ namespace: "d", key: "k", content: "first" });
            store.upsert({ namespace: "d", key: "k", content: "second" });
            const rows = store.list("d");
            checkEqual(rows.length, 1, "upsert: still one row");
            checkEqual(rows[0]?.content, "second", "upsert: content overwritten");
            store.close();
        }

        // =====================================================================
        // 5. Upsert does not create duplicate FTS rows
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "ftsdup.sqlite3"));
            store.upsert({ namespace: "d", key: "k", content: "original text" });
            store.upsert({ namespace: "d", key: "k", content: "updated text" });
            const matches = store.search("updated");
            checkEqual(matches.length, 1, "ftsdup: exactly one match after upsert");
            const stale = store.search("original");
            checkEqual(stale.length, 0, "ftsdup: old content removed from FTS index");
            store.close();
        }

        // =====================================================================
        // 6. Search by keyword in content
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "search.sqlite3"));
            store.upsert({
                namespace: "d",
                key: "1",
                content: "the quick brown fox jumps over the lazy dog",
            });
            store.upsert({
                namespace: "d",
                key: "2",
                content: "python is a programming language",
            });
            store.upsert({
                namespace: "d",
                key: "3",
                content: "typescript is a superset of javascript",
            });

            const fox = store.search("fox");
            checkEqual(fox.length, 1, "search/fox: one match");
            checkEqual(fox[0]?.key, "1", "search/fox: correct key");

            const typescript = store.search("typescript");
            checkEqual(typescript.length, 1, "search/typescript: one match");
            checkEqual(typescript[0]?.key, "3", "search/typescript: correct key");

            const absent = store.search("zzznothere");
            checkEqual(absent.length, 0, "search/absent: no match");

            store.close();
        }

        // =====================================================================
        // 7. Search by tag
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "tags.sqlite3"));
            store.upsert({
                namespace: "d",
                key: "a",
                content: "first note",
                tags: ["urgent", "home"],
            });
            store.upsert({
                namespace: "d",
                key: "b",
                content: "second note",
                tags: ["work"],
            });

            const urgent = store.search("urgent");
            checkEqual(urgent.length, 1, "search/tag: urgent matches one");
            checkEqual(urgent[0]?.key, "a", "search/tag: correct key for urgent");

            const work = store.search("work");
            checkEqual(work.length, 1, "search/tag: work matches one");
            checkEqual(work[0]?.key, "b", "search/tag: correct key for work");

            store.close();
        }

        // =====================================================================
        // 8. Search with namespace filter
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "ns.sqlite3"));
            store.upsert({ namespace: "ns1", key: "k", content: "shared topic" });
            store.upsert({ namespace: "ns2", key: "k", content: "shared topic" });

            const all = store.search("shared");
            checkEqual(all.length, 2, "search/ns: both namespaces match");

            const onlyNs1 = store.search("shared", { namespace: "ns1" });
            checkEqual(onlyNs1.length, 1, "search/ns: filtered to ns1");
            checkEqual(onlyNs1[0]?.namespace, "ns1", "search/ns: namespace is ns1");

            const onlyNs2 = store.search("shared", { namespace: "ns2" });
            checkEqual(onlyNs2.length, 1, "search/ns: filtered to ns2");
            checkEqual(onlyNs2[0]?.namespace, "ns2", "search/ns: namespace is ns2");

            store.close();
        }

        // =====================================================================
        // 9. Search edge cases
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "edge.sqlite3"));
            store.upsert({ namespace: "d", key: "k", content: "hello world" });

            checkEqual(store.search(""), [], "search/empty: returns []");
            checkEqual(store.search("   "), [], "search/whitespace: returns []");
            checkEqual(store.search("!@#$%"), [], "search/symbols: returns []");

            // Special characters that FTS5 treats as syntax are quoted away.
            const quoted = store.search('"hello"');
            checkEqual(quoted.length, 1, "search/quoted: does not throw, matches");
            checkEqual(quoted[0]?.key, "k", "search/quoted: correct key");

            store.close();
        }

        // =====================================================================
        // 10. Search respects limit
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "limit.sqlite3"));
            for (let i = 0; i < 10; i += 1) {
                store.upsert({
                    namespace: "d",
                    key: `k${i}`,
                    content: `matching term number ${i}`,
                });
            }
            const limited = store.search("matching", { limit: 3 });
            checkEqual(limited.length, 3, "search/limit: respects limit");
            store.close();
        }

        // =====================================================================
        // 11. Forget
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "forget.sqlite3"));
            store.upsert({ namespace: "d", key: "k", content: "unique term zebra" });
            checkEqual(
                store.search("zebra").length,
                1,
                "forget: entry searchable before forget",
            );
            const removed = store.forget("d", "k");
            checkEqual(removed, true, "forget: returns true when row existed");
            checkEqual(
                store.search("zebra").length,
                0,
                "forget: FTS index cleaned up",
            );
            checkEqual(store.list("d").length, 0, "forget: base table empty");

            const missing = store.forget("d", "k");
            checkEqual(missing, false, "forget: returns false when row missing");
            store.close();
        }

        // =====================================================================
        // 12. List
        // =====================================================================
        {
            const store = new MemoryStore(join(tmp.path, "list.sqlite3"));
            store.upsert({ namespace: "d", key: "k1", content: "one" });
            // Small sleep so updated_at values differ even on a fast machine.
            await new Promise((r) => setTimeout(r, 10));
            store.upsert({ namespace: "d", key: "k2", content: "two" });
            await new Promise((r) => setTimeout(r, 10));
            store.upsert({ namespace: "d", key: "k3", content: "three" });

            const all = store.list("d");
            checkEqual(all.length, 3, "list: three entries");
            checkEqual(all[0]?.key, "k3", "list: most recently updated first");
            checkEqual(all[2]?.key, "k1", "list: oldest last");

            const limited = store.list("d", 2);
            checkEqual(limited.length, 2, "list: respects limit");

            // Different namespace is isolated.
            store.upsert({ namespace: "other", key: "x", content: "different" });
            const onlyD = store.list("d");
            checkEqual(onlyD.length, 3, "list: namespace isolated from other");
            const onlyOther = store.list("other");
            checkEqual(onlyOther.length, 1, "list: other namespace has only its entry");

            store.close();
        }

        // =====================================================================
        // 13. Memory tools: permission tiers
        // =====================================================================
        const storeForTools = new MemoryStore(join(tmp.path, "tools.sqlite3"));
        const tools = makeMemoryTools(storeForTools);
        const byName = new Map<string, BaseTool>(tools.map((t) => [t.name, t]));

        checkEqual(
            byName.get("remember")?.permission,
            "mutate",
            "tools: remember is mutate",
        );
        checkEqual(
            byName.get("forget")?.permission,
            "mutate",
            "tools: forget is mutate",
        );
        checkEqual(
            byName.get("recall")?.permission,
            "read",
            "tools: recall is read",
        );
        checkEqual(
            byName.get("list_memories")?.permission,
            "read",
            "tools: list_memories is read",
        );

        // =====================================================================
        // 14. Memory tools: run() round-trip
        // =====================================================================
        {
            const remember = byName.get("remember");
            const recall = byName.get("recall");
            const forget = byName.get("forget");
            const listTool = byName.get("list_memories");
            if (
                remember === undefined ||
                recall === undefined ||
                forget === undefined ||
                listTool === undefined
            ) {
                check(false, "tools: all four tools present");
                return;
            }

            // remember
            const rememberResult = await remember.run({
                key: "greeting",
                content: "hello there",
                tags: ["misc"],
            });
            check(
                String(rememberResult[0]).startsWith("remembered"),
                "tools/remember: returns confirmation",
            );

            // list_memories
            const listResult = await listTool.run({ namespace: "default" });
            const listText = String(listResult[0]);
            check(
                listText.includes("greeting"),
                "tools/list: includes greeting",
            );
            check(
                listText.includes("hello there"),
                "tools/list: includes content",
            );
            check(
                listText.includes("tags: misc"),
                "tools/list: includes tags",
            );

            // recall
            const recallResult = await recall.run({ query: "hello" });
            const recallText = String(recallResult[0]);
            check(
                recallText.includes("greeting"),
                "tools/recall: found by keyword",
            );

            const recallMiss = await recall.run({ query: "xyznotpresent" });
            checkEqual(
                String(recallMiss[0]),
                "no matching memories",
                "tools/recall: miss message",
            );

            // forget
            const forgetResult = await forget.run({ key: "greeting" });
            checkEqual(
                String(forgetResult[0]),
                "forgot default/greeting",
                "tools/forget: confirmation",
            );

            const forgotMissing = await forget.run({ key: "greeting" });
            checkEqual(
                String(forgotMissing[0]),
                "no memory at default/greeting",
                "tools/forget: missing message",
            );
        }

        // =====================================================================
        // 15. Agent end-to-end (fake LLM, real store + real tools)
        // =====================================================================
        {
            const e2ePath = join(tmp.path, "e2e.sqlite3");
            const store = new MemoryStore(e2ePath);
            const e2eTools = makeMemoryTools(store);

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "remember", {
                        key: "capital",
                        content: "the capital of France is Paris",
                        tags: ["geo"],
                    }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "recall", { query: "France" }),
                ]),
                textResponse("noted"),
            ]);

            const agent = new Agent({
                llmClient: client,
                tools: e2eTools,
                confirmToolCall: () => true,
            });
            const result = await agent.run("remember and recall France");

            checkEqual(result.context.currentStep, 3, "e2e: three steps");
            checkEqual(result.finalResult?.kind, "text", "e2e: text final");

            // Underlying store got the write.
            const rows = store.list("default");
            checkEqual(rows.length, 1, "e2e: one row stored");
            checkEqual(rows[0]?.key, "capital", "e2e: correct key stored");

            // Recall executed as a tool call with an FTS query.
            const recallToolResult = result.context.events
                .flatMap((e) => e.content)
                .filter((c) => c.type === "tool_result")
                .map((c) => (c.type === "tool_result" ? c.toolResult : null))
                .filter((r) => r !== null && r.name === "recall");
            checkEqual(recallToolResult.length, 1, "e2e: recall executed once");
            if (recallToolResult[0] !== undefined && recallToolResult[0] !== null) {
                checkEqual(
                    recallToolResult[0].status,
                    "success",
                    "e2e: recall succeeded",
                );
                const text = String(recallToolResult[0].content[0]);
                check(
                    text.includes("Paris"),
                    "e2e: recall returned the stored content",
                );
            }

            // Without a confirmToolCall, `remember` (mutate) is denied.
            const denyClient = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("d1", "remember", {
                        key: "denied",
                        content: "should not be stored",
                    }),
                ]),
                textResponse("done"),
            ]);
            const denyAgent = new Agent({
                llmClient: denyClient,
                tools: makeMemoryTools(store),
                // no confirmToolCall
            });
            await denyAgent.run("try to remember");
            const denyRows = store.list("default");
            checkSoft(
                !denyRows.some((r) => r.key === "denied"),
                "e2e: mutate denied when no confirm callback",
            );

            store.close();
        }

        // =====================================================================
        // 16. In-memory DB works (no WAL, no file)
        // =====================================================================
        {
            const mem = new MemoryStore(":memory:");
            mem.upsert({ namespace: "d", key: "k", content: "in-memory" });
            checkEqual(mem.search("in-memory").length, 1, "memory-db: search works");
            checkEqual(mem.list("d").length, 1, "memory-db: list works");
            mem.close();
        }
    } finally {
        tmp.cleanup();
    }
});