import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "../src/agent/agent.js";
import { McpConnection } from "../src/agent/client.js";
import {
    MemoryStore,
    type MemoryRow,
} from "../src/agent/memory.js";
import { runResearchBrief } from "../src/workflows/research-brief.js";
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
    skip,
} from "./_verify-common.js";

const SAMPLE_BRIEF = `## Summary
TypeScript is a statically typed superset of JavaScript that compiles to plain JavaScript.

## Key Facts
- TypeScript was developed by Microsoft.
- TypeScript adds static types to JavaScript.
- TypeScript is widely used for large-scale web applications.

## Sources
- TypeScript Handbook (https://www.typescriptlang.org/docs/)

## Open Questions
- What is the roadmap for TypeScript 6.0?
`;

/**
 * Build the MCP connection the workflow should use. The `WORKSPACE_ROOT`
 * is the output directory of the workflow under test, so `write_file`
 * writes to `<outputDir>/brief.md`.
 */
async function makeConnection(workspaceRoot: string): Promise<McpConnection> {
    const conn = new McpConnection("tsagent", {
        command: process.execPath,
        args: ["--import", "tsx", "src/agent/server.ts"],
        env: {
            WORKSPACE_ROOT: workspaceRoot,
            TAVILY_API_KEY: "", // forces search_web to error; the workflow
            // requires the call to happen, not the call to succeed
        },
        connectTimeoutMs: 30_000,
    });
    await conn.connect();
    return conn;
}

runScript(async () => {
    const tmp = makeTempDir("research-brief");

    try {
        // =====================================================================
        // 1. Happy path
        // =====================================================================
        {
            const outputDir = join(tmp.path, "happy");
            mkdirSync(outputDir, { recursive: true });
            const connection = await makeConnection(outputDir);

            try {
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "TypeScript" }),
                    ]),
                    toolCallResponse([
                        makeToolCall("c2", "write_file", {
                            path: "brief.md",
                            content: SAMPLE_BRIEF,
                        }),
                    ]),
                    textResponse("Brief written to brief.md."),
                ]);

                const result = await runResearchBrief({
                    topic: "TypeScript",
                    outputDir,
                    llmClient: client,
                    connection,
                    skipMemory: true,
                    confirmToolCall: () => true,
                });

                checkEqual(result.exitCode, 0, "happy: exit 0");
                check(result.briefPath !== null, "happy: briefPath set");
                checkEqual(
                    result.briefPath,
                    join(outputDir, "brief.md"),
                    "happy: exact brief path",
                );
                check(result.error === null, "happy: no error");
                check(result.summary !== null, "happy: summary extracted");
                check(
                    result.summary?.startsWith("TypeScript is a statically typed") ??
                    false,
                    "happy: summary content correct",
                );

                // Log file present.
                const logContent = readFileSync(join(outputDir, "run.log.jsonl"), "utf8");
                check(logContent.length > 0, "happy: log file written");
                check(
                    logContent.includes("search_web"),
                    "happy: log contains search_web call",
                );

                // Both required tools were called.
                const callNames = result.context?.events
                    .flatMap((e) => e.content)
                    .filter((c) => c.type === "tool_call")
                    .map((c) => (c.type === "tool_call" ? c.toolCall.name : "")) ?? [];
                check(callNames.includes("search_web"), "happy: search_web invoked");
                check(callNames.includes("write_file"), "happy: write_file invoked");
            } finally {
                await connection.close();
            }
        }

        // =====================================================================
        // 2. Auto-recall: memory context is prepended to the prompt
        // =====================================================================
        {
            const outputDir = join(tmp.path, "recall");
            mkdirSync(outputDir, { recursive: true });
            const memoryPath = join(tmp.path, "recall-memory.sqlite3");
            const memory = new MemoryStore(memoryPath);
            memory.upsert({
                namespace: "briefs",
                key: "typescript-prior",
                content: "Prior research: TypeScript was created in 2012.",
                tags: ["research-brief"],
            });

            const connection = await makeConnection(outputDir);
            try {
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "TypeScript" }),
                    ]),
                    toolCallResponse([
                        makeToolCall("c2", "write_file", {
                            path: "brief.md",
                            content: SAMPLE_BRIEF,
                        }),
                    ]),
                    textResponse("done"),
                ]);

                const result = await runResearchBrief({
                    topic: "TypeScript",
                    outputDir,
                    llmClient: client,
                    connection,
                    memoryStore: memory,
                    confirmToolCall: () => true,
                });

                checkEqual(result.exitCode, 0, "recall: exit 0");

                // First LLM call's user message must include prior context.
                const firstCall = client.calls[0];
                check(firstCall !== undefined, "recall: first LLM call captured");
                const firstUserMessage = firstCall?.events
                    .flatMap((e) => e.content)
                    .find(
                        (c) => c.type === "message" && c.message.role === "user",
                    );
                if (firstUserMessage?.type === "message") {
                    check(
                        firstUserMessage.message.content?.includes("Prior research") === true,
                        "recall: prior memory prepended to prompt",
                    );
                    check(
                        firstUserMessage.message.content?.includes("created in 2012") === true,
                        "recall: prior memory content included",
                    );
                } else {
                    check(false, "recall: user message present");
                }

                // Auto-store: summary stored under key=slug ("typescript").
                const stored = memory.list("briefs");
                check(
                    stored.some((r) => r.key === "typescript"),
                    "recall: summary auto-stored under slug",
                );
                const storedRow = stored.find((r) => r.key === "typescript");
                check(
                    storedRow?.content.startsWith("TypeScript is a statically typed") ??
                    false,
                    "recall: stored summary content matches",
                );
                checkEqual(
                    result.memoryKey,
                    "typescript",
                    "recall: result.memoryKey set",
                );
            } finally {
                await connection.close();
                memory.close();
            }
        }

        // =====================================================================
        // 3. Missing section -> failure, cleanup
        // =====================================================================
        {
            const outputDir = join(tmp.path, "missing-section");
            mkdirSync(outputDir, { recursive: true });

            const badBrief = `## Summary
Only the summary, no other sections.
`;

            const connection = await makeConnection(outputDir);
            try {
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "x" }),
                    ]),
                    toolCallResponse([
                        makeToolCall("c2", "write_file", {
                            path: "brief.md",
                            content: badBrief,
                        }),
                    ]),
                    textResponse("done"),
                ]);

                const result = await runResearchBrief({
                    topic: "Broken",
                    outputDir,
                    llmClient: client,
                    connection,
                    skipMemory: true,
                    confirmToolCall: () => true,
                });

                checkEqual(result.exitCode, 1, "missing-section: exit 1");
                check(result.error !== null, "missing-section: error present");
                check(
                    result.error?.includes("missing required section") ?? false,
                    "missing-section: error mentions missing section",
                );
            } finally {
                await connection.close();
            }
        }

        // =====================================================================
        // 4. search_web never called -> invariant failure
        // =====================================================================
        {
            const outputDir = join(tmp.path, "no-search");
            mkdirSync(outputDir, { recursive: true });
            const connection = await makeConnection(outputDir);
            try {
                const client = new ScriptedClient([
                    // Skip search_web and go straight to write_file.
                    toolCallResponse([
                        makeToolCall("c1", "write_file", {
                            path: "brief.md",
                            content: SAMPLE_BRIEF,
                        }),
                    ]),
                    textResponse("done"),
                ]);

                const result = await runResearchBrief({
                    topic: "NoSearch",
                    outputDir,
                    llmClient: client,
                    connection,
                    skipMemory: true,
                    confirmToolCall: () => true,
                });

                checkEqual(result.exitCode, 1, "no-search: exit 1");
                check(
                    result.error?.includes("search_web was never called") ?? false,
                    "no-search: error identifies the missing tool",
                );
            } finally {
                await connection.close();
            }
        }

        // =====================================================================
        // 5. write_file never called -> invariant failure
        // =====================================================================
        {
            const outputDir = join(tmp.path, "no-write");
            mkdirSync(outputDir, { recursive: true });
            const connection = await makeConnection(outputDir);
            try {
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "x" }),
                    ]),
                    textResponse("done without writing"),
                ]);

                const result = await runResearchBrief({
                    topic: "NoWrite",
                    outputDir,
                    llmClient: client,
                    connection,
                    skipMemory: true,
                    confirmToolCall: () => true,
                });

                checkEqual(result.exitCode, 1, "no-write: exit 1");
                check(
                    result.error?.includes("write_file was never called") ?? false,
                    "no-write: error identifies the missing tool",
                );
            } finally {
                await connection.close();
            }
        }

        // =====================================================================
        // 6. Missing file on disk -> failure
        // =====================================================================
        {
            const outputDir = join(tmp.path, "missing-file");
            mkdirSync(outputDir, { recursive: true });
            const connection = await makeConnection(outputDir);
            try {
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "x" }),
                    ]),
                    // write_file to a different path — brief.md at the exact
                    // path is what the workflow validates.
                    toolCallResponse([
                        makeToolCall("c2", "write_file", {
                            path: "somewhere/brief.md",
                            content: SAMPLE_BRIEF,
                        }),
                    ]),
                    textResponse("done"),
                ]);

                const result = await runResearchBrief({
                    topic: "WrongPath",
                    outputDir,
                    llmClient: client,
                    connection,
                    skipMemory: true,
                    confirmToolCall: () => true,
                });

                checkEqual(result.exitCode, 1, "wrong-path: exit 1");
                check(
                    result.error?.includes("expected path") ?? false,
                    "wrong-path: error mentions expected path",
                );
            } finally {
                await connection.close();
            }
        }

        // =====================================================================
        // 7. Cleanup-on-failure vs. keepOnFailure
        // =====================================================================
        {
            const failureOutput = join(tmp.path, "failure-cleanup");
            mkdirSync(failureOutput, { recursive: true });
            const connection = await makeConnection(failureOutput);
            try {
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "x" }),
                    ]),
                    textResponse("no write"),
                ]);
                await runResearchBrief({
                    topic: "Cleanup",
                    outputDir: failureOutput,
                    llmClient: client,
                    connection,
                    skipMemory: true,
                    confirmToolCall: () => true,
                });
                // The workflow should have removed outputDir.
                let removed = true;
                try {
                    readFileSync(join(failureOutput, "run.log.jsonl"));
                    removed = false;
                } catch {
                    removed = true;
                }
                check(removed, "cleanup-on-failure: output dir removed");
            } finally {
                await connection.close();
            }
        }

        {
            const keepOutput = join(tmp.path, "keep-on-failure");
            mkdirSync(keepOutput, { recursive: true });
            const connection = await makeConnection(keepOutput);
            try {
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "x" }),
                    ]),
                    textResponse("no write"),
                ]);
                await runResearchBrief({
                    topic: "Keep",
                    outputDir: keepOutput,
                    llmClient: client,
                    connection,
                    skipMemory: true,
                    keepOnFailure: true,
                    confirmToolCall: () => true,
                });
                // Log file should still exist.
                let exists = true;
                try {
                    readFileSync(join(keepOutput, "run.log.jsonl"));
                } catch {
                    exists = false;
                }
                check(exists, "keep-on-failure: output dir preserved");
            } finally {
                await connection.close();
            }
        }

        // =====================================================================
        // 8. Graceful memory failure: recall throws, workflow still succeeds
        // =====================================================================
        {
            class BrokenRecallStore extends MemoryStore {
                override search(): MemoryRow[] {
                    throw new Error("intentional recall failure");
                }
            }

            const outputDir = join(tmp.path, "broken-recall");
            mkdirSync(outputDir, { recursive: true });
            const memory = new BrokenRecallStore(join(tmp.path, "broken-recall.db"));
            const connection = await makeConnection(outputDir);
            try {
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "x" }),
                    ]),
                    toolCallResponse([
                        makeToolCall("c2", "write_file", {
                            path: "brief.md",
                            content: SAMPLE_BRIEF,
                        }),
                    ]),
                    textResponse("done"),
                ]);

                const result = await runResearchBrief({
                    topic: "BrokenRecall",
                    outputDir,
                    llmClient: client,
                    connection,
                    memoryStore: memory,
                    confirmToolCall: () => true,
                });

                checkEqual(
                    result.exitCode,
                    0,
                    "broken-recall: workflow still succeeds",
                );
                check(
                    result.summary !== null,
                    "broken-recall: summary still extracted",
                );
            } finally {
                await connection.close();
            }
        }

        // =====================================================================
        // 9. Graceful memory failure: upsert throws, workflow still succeeds
        // =====================================================================
        {
            class BrokenStoreStore extends MemoryStore {
                override upsert(): void {
                    throw new Error("intentional store failure");
                }
            }

            const outputDir = join(tmp.path, "broken-store");
            mkdirSync(outputDir, { recursive: true });
            const memory = new BrokenStoreStore(join(tmp.path, "broken-store.db"));
            const connection = await makeConnection(outputDir);
            try {
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "x" }),
                    ]),
                    toolCallResponse([
                        makeToolCall("c2", "write_file", {
                            path: "brief.md",
                            content: SAMPLE_BRIEF,
                        }),
                    ]),
                    textResponse("done"),
                ]);

                const result = await runResearchBrief({
                    topic: "BrokenStore",
                    outputDir,
                    llmClient: client,
                    connection,
                    memoryStore: memory,
                    confirmToolCall: () => true,
                });

                checkEqual(
                    result.exitCode,
                    0,
                    "broken-store: workflow still succeeds",
                );
                checkEqual(
                    result.memoryKey,
                    null,
                    "broken-store: memoryKey is null (store failed)",
                );
            } finally {
                await connection.close();
            }
        }

        // =====================================================================
        // 10. Quota exhausted -> exit 3
        // =====================================================================
        {
            const outputDir = join(tmp.path, "quota");
            mkdirSync(outputDir, { recursive: true });
            const connection = await makeConnection(outputDir);
            try {
                const client = new ScriptedClient([
                    {
                        text: null,
                        toolCalls: [],
                        usage: null,
                        providerOptions: {},
                        errorMessage: "quota exceeded",
                        errorMetadata: {
                            errorType: "quota",
                            quotaExhausted: true,
                            statusCode: 429,
                        },
                    },
                ]);
                const result = await runResearchBrief({
                    topic: "Quota",
                    outputDir,
                    llmClient: client,
                    connection,
                    skipMemory: true,
                    confirmToolCall: () => true,
                });
                checkEqual(result.exitCode, 3, "quota: exit 3");
            } finally {
                await connection.close();
            }
        }

        // =====================================================================
        // 11. Slug generation
        // =====================================================================
        {
            const { slugify } = await import("../src/workflows/_shared.js");
            checkEqual(slugify("TypeScript"), "typescript", "slug: simple");
            checkEqual(
                slugify("The History of Rome"),
                "the-history-of-rome",
                "slug: with spaces",
            );
            checkEqual(
                slugify("Café au lait!"),
                "cafe-au-lait",
                "slug: strips diacritics and punctuation",
            );
            checkEqual(slugify("!!!"), "brief", "slug: empty falls back to 'brief'");
        }

        // =====================================================================
        // 12. Prompt composition includes required tool hints
        // =====================================================================
        {
            const outputDir = join(tmp.path, "prompt-check");
            mkdirSync(outputDir, { recursive: true });
            const connection = await makeConnection(outputDir);
            try {
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "x" }),
                    ]),
                    toolCallResponse([
                        makeToolCall("c2", "write_file", {
                            path: "brief.md",
                            content: SAMPLE_BRIEF,
                        }),
                    ]),
                    textResponse("done"),
                ]);

                await runResearchBrief({
                    topic: "PromptCheck",
                    outputDir,
                    llmClient: client,
                    connection,
                    skipMemory: true,
                    confirmToolCall: () => true,
                });

                // Check the workflow's own instructions array contains the
                // required-tool hints and section list.
                const firstCall = client.calls[0];
                const instructions = firstCall?.instructions ?? [];
                const combined = instructions.join("\n");
                check(combined.includes("search_web"), "prompt: mentions search_web");
                check(combined.includes("write_file"), "prompt: mentions write_file");
                check(combined.includes("## Summary"), "prompt: mentions ## Summary");
                check(combined.includes("## Key Facts"), "prompt: mentions ## Key Facts");
                check(combined.includes("## Sources"), "prompt: mentions ## Sources");
                check(
                    combined.includes("## Open Questions"),
                    "prompt: mentions ## Open Questions",
                );
            } finally {
                await connection.close();
            }
        }

        // =====================================================================
        // 13. Wrapper: memory injected via memoryStore overrides memoryPath
        // =====================================================================
        {
            const outputDir = join(tmp.path, "injected-memory");
            mkdirSync(outputDir, { recursive: true });
            const memory = new MemoryStore(join(tmp.path, "injected.db"));
            const connection = await makeConnection(outputDir);
            try {
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "x" }),
                    ]),
                    toolCallResponse([
                        makeToolCall("c2", "write_file", {
                            path: "brief.md",
                            content: SAMPLE_BRIEF,
                        }),
                    ]),
                    textResponse("done"),
                ]);
                const result = await runResearchBrief({
                    topic: "Injected",
                    outputDir,
                    llmClient: client,
                    connection,
                    memoryStore: memory,
                    confirmToolCall: () => true,
                });
                checkEqual(result.exitCode, 0, "injected-memory: exit 0");
                check(
                    memory.list("briefs").some((r) => r.key === "injected"),
                    "injected-memory: stored in the injected store",
                );
            } finally {
                await connection.close();
                memory.close();
            }
        }

        // =====================================================================
        // 14. Spawn failure path is testable via MCP_SERVER_COMMAND
        // =====================================================================
        {
            const outputDir = join(tmp.path, "spawn-fail");
            mkdirSync(outputDir, { recursive: true });
            const originalCommand = process.env.MCP_SERVER_COMMAND;
            process.env.MCP_SERVER_COMMAND = "/nonexistent-tsagent-test-command";
            try {
                const result = await runResearchBrief({
                    topic: "SpawnFail",
                    outputDir,
                    skipMemory: true,
                    llmClient: new ScriptedClient([]), // never used
                });
                checkEqual(result.exitCode, 1, "spawn-fail: exit 1");
                check(
                    result.error?.includes("MCP server failed to start") ?? false,
                    "spawn-fail: error mentions MCP spawn",
                );
            } finally {
                if (originalCommand === undefined) {
                    delete process.env.MCP_SERVER_COMMAND;
                } else {
                    process.env.MCP_SERVER_COMMAND = originalCommand;
                }
            }
        }

        // =====================================================================
        // 15. Empty topic -> usage error
        // =====================================================================
        {
            const result = await runResearchBrief({
                topic: "   ",
                skipMemory: true,
                llmClient: new ScriptedClient([]),
            });
            checkEqual(result.exitCode, 2, "empty-topic: exit 2");
        }

        // =====================================================================
        // 16. skipMemory disables memory entirely
        // =====================================================================
        {
            const outputDir = join(tmp.path, "skip-memory");
            mkdirSync(outputDir, { recursive: true });
            const connection = await makeConnection(outputDir);
            try {
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "x" }),
                    ]),
                    toolCallResponse([
                        makeToolCall("c2", "write_file", {
                            path: "brief.md",
                            content: SAMPLE_BRIEF,
                        }),
                    ]),
                    textResponse("done"),
                ]);
                const result = await runResearchBrief({
                    topic: "SkipMemory",
                    outputDir,
                    llmClient: client,
                    connection,
                    skipMemory: true,
                    confirmToolCall: () => true,
                });
                checkEqual(result.exitCode, 0, "skip-memory: exit 0");
                checkEqual(result.memoryKey, null, "skip-memory: no memoryKey");
            } finally {
                await connection.close();
            }
        }

        skip(
            "live-API: running the workflow against real Gemini requires GEMINI_API_KEY (not set) — " +
            "run `npx tsx src/workflows/research-brief.ts \"<topic>\"` manually to smoke-test",
        );
    } finally {
        // Best-effort cleanup.
        try {
            rmSync(tmp.path, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }
});

// Silence unused-import warnings.
void writeFileSync;
void Agent;