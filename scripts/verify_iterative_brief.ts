import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpConnection } from "../src/agent/client.js";
import { MemoryStore } from "../src/agent/memory.js";
import { runIterativeBrief } from "../src/workflows/iterative-brief.js";
import { listVersions, slugify } from "../src/workflows/_shared.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import {
    check,
    checkEqual,
    makeTempDir,
    runScript,
} from "./_verify-common.js";

const SAMPLE_BRIEF_V1 = `## Summary
TypeScript is a statically typed superset of JavaScript that compiles to plain JavaScript.

## Key Facts
- TypeScript was developed by Microsoft.
- TypeScript adds static types to JavaScript.

## Sources
- TypeScript Handbook (https://www.typescriptlang.org/docs/)

## Open Questions
- What is the roadmap for TypeScript 6.0?
`;

const SAMPLE_BRIEF_V2 = `## Summary
TypeScript is a statically typed superset of JavaScript used widely for large-scale applications.

## Key Facts
- TypeScript was developed by Microsoft.
- TypeScript adds static types to JavaScript.
- TypeScript is the standard for large-scale web apps at major companies.

## Sources
- TypeScript Handbook (https://www.typescriptlang.org/docs/)
- TypeScript 5.0 release notes (https://devblogs.microsoft.com/typescript/)

## Open Questions
- How does Bun's TypeScript support compare?
`;

function makeConnectionFactory(
    getToken: () => string,
): (workspaceRoot: string) => Promise<McpConnection> {
    return async (workspaceRoot: string) => {
        const conn = new McpConnection("tsagent", {
            command: process.execPath,
            args: ["--import", "tsx", "src/agent/server.ts"],
            env: {
                WORKSPACE_ROOT: workspaceRoot,
                TAVILY_API_KEY: "",
            },
            connectTimeoutMs: 30_000,
        });
        await conn.connect();
        void getToken();
        return conn;
    };
}

runScript(async () => {
    const tmp = makeTempDir("iterative-brief");
    try {
        // =====================================================================
        // 1. Fresh run creates v1
        // =====================================================================
        const baseA = join(tmp.path, "base-a");
        {
            const client = new ScriptedClient([
                toolCallResponse([makeToolCall("c1", "search_web", { query: "TypeScript" })]),
                toolCallResponse([
                    makeToolCall("c2", "write_file", {
                        path: "brief.md",
                        content: SAMPLE_BRIEF_V1,
                    }),
                ]),
                textResponse("Brief written."),
            ]);

            const result = await runIterativeBrief({
                topic: "TypeScript",
                baseDir: baseA,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(() => ""),
            });

            checkEqual(result.exitCode, 0, "fresh: exit 0");
            checkEqual(result.version, 1, "fresh: version 1");
            checkEqual(result.refinedFrom, null, "fresh: refinedFrom null");
            check(
                result.briefPath !== null && result.briefPath.endsWith("v1/brief.md"),
                "fresh: brief path under v1",
            );
            check(listVersions(baseA).includes(1), "fresh: v1 dir on disk");
        }

        // =====================================================================
        // 2. Fresh run on existing baseDir → exit 2, no change
        // =====================================================================
        {
            const client = new ScriptedClient([]); // never called
            const result = await runIterativeBrief({
                topic: "TypeScript",
                baseDir: baseA,
                llmClient: client,
                skipMemory: true,
            });
            checkEqual(result.exitCode, 2, "fresh-existing: exit 2");
            check(
                result.error?.includes("already exist") ?? false,
                "fresh-existing: error mentions existing versions",
            );
            checkEqual(client.calls.length, 0, "fresh-existing: LLM never called");
            // v1 unchanged.
            checkEqual(listVersions(baseA), [1], "fresh-existing: only v1 remains");
        }

        // =====================================================================
        // 3. Refine → v2, preserves v1
        // =====================================================================
        let v1ContentBefore: string;
        {
            v1ContentBefore = readFileSync(join(baseA, "v1", "brief.md"), "utf8");

            const client = new ScriptedClient([
                toolCallResponse([makeToolCall("d1", "search_web", { query: "TypeScript updates" })]),
                toolCallResponse([
                    makeToolCall("d2", "write_file", {
                        path: "brief.md",
                        content: SAMPLE_BRIEF_V2,
                    }),
                ]),
                textResponse("Refined."),
            ]);

            const result = await runIterativeBrief({
                topic: "TypeScript",
                baseDir: baseA,
                refinement: "Add sources and focus on large-scale adoption.",
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(() => ""),
            });

            checkEqual(result.exitCode, 0, "refine: exit 0");
            checkEqual(result.version, 2, "refine: version 2");
            checkEqual(result.refinedFrom, 1, "refine: refinedFrom 1");
            check(
                result.briefPath !== null && result.briefPath.endsWith("v2/brief.md"),
                "refine: brief path under v2",
            );
            checkEqual(listVersions(baseA), [1, 2], "refine: v1 and v2 on disk");

            // v1 brief.md unchanged.
            const v1ContentAfter = readFileSync(join(baseA, "v1", "brief.md"), "utf8");
            checkEqual(
                v1ContentAfter,
                v1ContentBefore,
                "refine: v1 brief.md byte-identical",
            );

            // v2 brief.md matches what the fake wrote.
            const v2Content = readFileSync(join(baseA, "v2", "brief.md"), "utf8");
            checkEqual(v2Content, SAMPLE_BRIEF_V2, "refine: v2 brief.md matches");
        }

        // =====================================================================
        // 4. v2's log contains v1's events (lineage)
        // =====================================================================
        {
            const v1Log = readFileSync(join(baseA, "v1", "run.log.jsonl"), "utf8");
            const v2Log = readFileSync(join(baseA, "v2", "run.log.jsonl"), "utf8");
            const v1LineCount = v1Log.split("\n").filter((l) => l.length > 0).length;
            const v2LineCount = v2Log.split("\n").filter((l) => l.length > 0).length;
            check(
                v2LineCount > v1LineCount,
                `refine/lineage: v2 log longer than v1 (${v2LineCount} > ${v1LineCount})`,
            );
            // First N lines of v2 equal the entirety of v1.
            const v2FirstLines = v2Log.split("\n").filter((l) => l.length > 0).slice(0, v1LineCount);
            const v1Lines = v1Log.split("\n").filter((l) => l.length > 0);
            checkEqual(v2FirstLines, v1Lines, "refine/lineage: v2 log starts with v1 events");
        }

        // =====================================================================
        // 5. Third refinement → v3
        // =====================================================================
        {
            const client = new ScriptedClient([
                toolCallResponse([makeToolCall("e1", "search_web", { query: "x" })]),
                toolCallResponse([
                    makeToolCall("e2", "write_file", {
                        path: "brief.md",
                        content: SAMPLE_BRIEF_V2,
                    }),
                ]),
                textResponse("v3 done."),
            ]);

            const result = await runIterativeBrief({
                topic: "TypeScript",
                baseDir: baseA,
                refinement: "One more pass.",
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(() => ""),
            });

            checkEqual(result.exitCode, 0, "v3: exit 0");
            checkEqual(result.version, 3, "v3: version 3");
            checkEqual(result.refinedFrom, 2, "v3: refinedFrom 2");
            checkEqual(listVersions(baseA), [1, 2, 3], "v3: v1, v2, v3 on disk");
        }

        // =====================================================================
        // 6. Refine with no prior version → exit 2
        // =====================================================================
        {
            const base = join(tmp.path, "empty-base");
            const client = new ScriptedClient([]);
            const result = await runIterativeBrief({
                topic: "Empty",
                baseDir: base,
                refinement: "refine",
                llmClient: client,
                skipMemory: true,
            });
            checkEqual(result.exitCode, 2, "refine-none: exit 2");
            check(
                result.error?.includes("no prior version") ?? false,
                "refine-none: error mentions no prior version",
            );
            checkEqual(client.calls.length, 0, "refine-none: LLM never called");
        }

        // =====================================================================
        // 7. Refine validates only the new turn
        // =====================================================================
        // The rehydrated v1 already contains search_web + write_file calls.
        // A refinement that never calls write_file must still fail.
        {
            const base = join(tmp.path, "newturn-validation");
            // Seed with a valid v1.
            const seedClient = new ScriptedClient([
                toolCallResponse([makeToolCall("s1", "search_web", { query: "seed" })]),
                toolCallResponse([
                    makeToolCall("s2", "write_file", {
                        path: "brief.md",
                        content: SAMPLE_BRIEF_V1,
                    }),
                ]),
                textResponse("seeded."),
            ]);
            await runIterativeBrief({
                topic: "Seed",
                baseDir: base,
                llmClient: seedClient,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(() => ""),
            });

            // Now attempt a refinement that only calls search_web, no write.
            const badClient = new ScriptedClient([
                toolCallResponse([makeToolCall("b1", "search_web", { query: "x" })]),
                textResponse("did not write."),
            ]);
            const result = await runIterativeBrief({
                topic: "Seed",
                baseDir: base,
                refinement: "dummy",
                llmClient: badClient,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(() => ""),
            });

            checkEqual(result.exitCode, 1, "newturn: exit 1");
            check(
                result.error?.includes("write_file was never called") ?? false,
                "newturn: error identifies missing write_file in the new turn",
            );
            // v1 preserved; v2 cleaned up.
            checkEqual(listVersions(base), [1], "newturn: only v1 remains after cleanup");
        }

        // =====================================================================
        // 8. Missing section in refined brief → failure
        // =====================================================================
        {
            const base = join(tmp.path, "missing-section");
            const seedClient = new ScriptedClient([
                toolCallResponse([makeToolCall("s1", "search_web", { query: "x" })]),
                toolCallResponse([
                    makeToolCall("s2", "write_file", {
                        path: "brief.md",
                        content: SAMPLE_BRIEF_V1,
                    }),
                ]),
                textResponse("seeded."),
            ]);
            await runIterativeBrief({
                topic: "Broken",
                baseDir: base,
                llmClient: seedClient,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(() => ""),
            });

            const badBrief = `## Summary
Only summary.
`;
            const badClient = new ScriptedClient([
                toolCallResponse([makeToolCall("b1", "search_web", { query: "x" })]),
                toolCallResponse([
                    makeToolCall("b2", "write_file", {
                        path: "brief.md",
                        content: badBrief,
                    }),
                ]),
                textResponse("did it."),
            ]);
            const result = await runIterativeBrief({
                topic: "Broken",
                baseDir: base,
                refinement: "break it",
                llmClient: badClient,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(() => ""),
            });

            checkEqual(result.exitCode, 1, "missing-section: exit 1");
            check(
                result.error?.includes("missing required section") ?? false,
                "missing-section: error mentions missing section",
            );
            checkEqual(listVersions(base), [1], "missing-section: v2 cleaned up");
        }

        // =====================================================================
        // 9. keepOnFailure preserves the failed version dir
        // =====================================================================
        {
            const base = join(tmp.path, "keep-on-failure");
            const seedClient = new ScriptedClient([
                toolCallResponse([makeToolCall("s1", "search_web", { query: "x" })]),
                toolCallResponse([
                    makeToolCall("s2", "write_file", {
                        path: "brief.md",
                        content: SAMPLE_BRIEF_V1,
                    }),
                ]),
                textResponse("seeded."),
            ]);
            await runIterativeBrief({
                topic: "Keep",
                baseDir: base,
                llmClient: seedClient,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(() => ""),
            });

            const badClient = new ScriptedClient([
                toolCallResponse([makeToolCall("b1", "search_web", { query: "x" })]),
                textResponse("no write."),
            ]);
            const result = await runIterativeBrief({
                topic: "Keep",
                baseDir: base,
                refinement: "fail",
                llmClient: badClient,
                skipMemory: true,
                keepOnFailure: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(() => ""),
            });

            checkEqual(result.exitCode, 1, "keep: exit 1");
            checkEqual(
                listVersions(base),
                [1, 2],
                "keep: v2 preserved on disk",
            );
        }

        // =====================================================================
        // 10. Memory auto-store overwrites key = slug on refine
        // =====================================================================
        {
            const base = join(tmp.path, "memory");
            const memoryPath = join(tmp.path, "memory.sqlite3");
            const memory = new MemoryStore(memoryPath);

            const seedClient = new ScriptedClient([
                toolCallResponse([makeToolCall("s1", "search_web", { query: "x" })]),
                toolCallResponse([
                    makeToolCall("s2", "write_file", {
                        path: "brief.md",
                        content: SAMPLE_BRIEF_V1,
                    }),
                ]),
                textResponse("seeded."),
            ]);
            const freshResult = await runIterativeBrief({
                topic: "TypeScript",
                baseDir: base,
                llmClient: seedClient,
                memoryStore: memory,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(() => ""),
            });
            checkEqual(freshResult.exitCode, 0, "memory/fresh: exit 0");
            const slug = slugify("TypeScript");
            const afterFresh = memory.list("briefs").find((r) => r.key === slug);
            check(afterFresh !== undefined, "memory/fresh: summary stored");
            check(
                afterFresh?.content.startsWith("TypeScript is a statically typed") ??
                false,
                "memory/fresh: stored summary is v1's",
            );

            const refineClient = new ScriptedClient([
                toolCallResponse([makeToolCall("d1", "search_web", { query: "x" })]),
                toolCallResponse([
                    makeToolCall("d2", "write_file", {
                        path: "brief.md",
                        content: SAMPLE_BRIEF_V2,
                    }),
                ]),
                textResponse("refined."),
            ]);
            const refineResult = await runIterativeBrief({
                topic: "TypeScript",
                baseDir: base,
                refinement: "update",
                llmClient: refineClient,
                memoryStore: memory,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(() => ""),
            });
            checkEqual(refineResult.exitCode, 0, "memory/refine: exit 0");
            const afterRefine = memory.list("briefs").find((r) => r.key === slug);
            check(afterRefine !== undefined, "memory/refine: entry still exists");
            check(
                afterRefine?.content.startsWith(
                    "TypeScript is a statically typed superset of JavaScript used widely",
                ) ?? false,
                "memory/refine: summary overwritten with v2's",
            );
            checkEqual(
                memory.list("briefs").length,
                1,
                "memory/refine: still one entry for the slug",
            );

            memory.close();
        }

        // =====================================================================
        // 11. listVersions + slugify helpers
        // =====================================================================
        {
            checkEqual(listVersions(join(tmp.path, "does-not-exist")), [], "listVersions: empty for missing dir");
            checkEqual(listVersions(baseA), [1, 2, 3], "listVersions: sorted ascending");
            checkEqual(slugify("Hello World"), "hello-world", "slugify: normal");
            checkEqual(slugify("!!!"), "brief", "slugify: empty → brief");
        }

        // =====================================================================
        // 12. Fresh: empty topic → exit 2
        // =====================================================================
        {
            const result = await runIterativeBrief({
                topic: "   ",
                skipMemory: true,
                llmClient: new ScriptedClient([]),
            });
            checkEqual(result.exitCode, 2, "empty-topic: exit 2");
        }

        // =====================================================================
        // 13. CLI parse failures
        // =====================================================================
        {
            // Directly exercise the CLI by spawning the workflow as a subprocess.
            const { spawnSync } = await import("node:child_process");
            const mainTsPath = join(process.cwd(), "src", "workflows", "iterative-brief.ts");

            const conflict = spawnSync(
                process.execPath,
                ["--import", "tsx", mainTsPath, "some-topic", "--approve", "--deny"],
                { encoding: "utf8", timeout: 20_000 },
            );
            checkEqual(conflict.status, 2, "cli: --approve --deny conflict → exit 2");
            check(
                typeof conflict.stderr === "string" &&
                conflict.stderr.includes("mutually exclusive"),
                "cli: conflict message",
            );

            const noTopic = spawnSync(
                process.execPath,
                ["--import", "tsx", mainTsPath],
                { encoding: "utf8", timeout: 20_000 },
            );
            checkEqual(noTopic.status, 2, "cli: missing topic → exit 2");

            void writeFileSync;
        }
    } finally {
        const { rmSync } = await import("node:fs");
        try {
            rmSync(tmp.path, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }
});