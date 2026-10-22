import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpConnection } from "../src/agent/client.js";
import {
    NoteDigestSchema,
    runNotesDigest,
    type NoteDigest,
} from "../src/workflows/notes-digest.js";
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

function makeConnectionFactory(): (
    workspaceRoot: string,
) => Promise<McpConnection> {
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
        return conn;
    };
}

function seedNotesDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, "note1.md"),
        "# Note 1\n\nToday I learned about TypeScript.\n",
    );
    writeFileSync(
        join(dir, "note2.md"),
        "# Note 2\n\nPython is also fine.\n",
    );
}

runScript(async () => {
    const tmp = makeTempDir("notes-digest");
    try {
        // =====================================================================
        // 1. Happy path
        // =====================================================================
        {
            const notesDir = join(tmp.path, "notes-happy");
            seedNotesDir(notesDir);
            const outputDir = join(tmp.path, "out-happy");

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "list_files", { pattern: "**/*.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "read_file", { path: "note1.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c3", "read_file", { path: "note2.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c4", "final_answer", {
                        output: {
                            summary: "Two notes covering TypeScript and Python.",
                            files_analyzed: [
                                {
                                    source_file: "note1.md",
                                    summary: "An introduction to TypeScript.",
                                    key_points: ["TypeScript is a typed JavaScript superset."],
                                },
                                {
                                    source_file: "note2.md",
                                    summary: "A note about Python.",
                                    key_points: ["Python is a general-purpose language."],
                                },
                            ],
                        },
                    }),
                ]),
            ]);

            const result = await runNotesDigest({
                notesDir,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 0, "happy: exit 0");
            check(result.jsonPath !== null, "happy: jsonPath set");
            check(result.markdownPath !== null, "happy: markdownPath set");
            checkEqual(
                result.jsonPath,
                join(outputDir, "digest.json"),
                "happy: exact json path",
            );
            checkEqual(
                result.markdownPath,
                join(outputDir, "digest.md"),
                "happy: exact markdown path",
            );
            check(result.error === null, "happy: no error");
            checkEqual(result.warnings.length, 0, "happy: no warnings");
            check(result.digest !== null, "happy: digest present");

            // JSON artifact parses against schema.
            const jsonContent = readFileSync(result.jsonPath!, "utf8");
            const parsed = NoteDigestSchema.safeParse(JSON.parse(jsonContent));
            check(parsed.success, "happy: json artifact matches schema");

            // Markdown artifact contains expected markers.
            const mdContent = readFileSync(result.markdownPath!, "utf8");
            check(mdContent.includes("# Notes Digest"), "happy: md title");
            check(
                mdContent.includes("Two notes covering TypeScript and Python."),
                "happy: md includes summary",
            );
            check(mdContent.includes("### `note1.md`"), "happy: md includes note1 heading");
            check(mdContent.includes("### `note2.md`"), "happy: md includes note2 heading");
            check(
                mdContent.includes("- TypeScript is a typed JavaScript superset."),
                "happy: md includes key point",
            );

            // Log written.
            const logContent = readFileSync(
                join(outputDir, "run.log.jsonl"),
                "utf8",
            );
            check(logContent.length > 0, "happy: log written");
        }

        // =====================================================================
        // 2. list_files never called -> fail
        // =====================================================================
        {
            const notesDir = join(tmp.path, "notes-no-list");
            seedNotesDir(notesDir);
            const outputDir = join(tmp.path, "out-no-list");

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "read_file", { path: "note1.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "final_answer", {
                        output: {
                            summary: "Did not list.",
                            files_analyzed: [
                                {
                                    source_file: "note1.md",
                                    summary: "A note.",
                                    key_points: [],
                                },
                            ],
                        },
                    }),
                ]),
            ]);

            const result = await runNotesDigest({
                notesDir,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 1, "no-list: exit 1");
            check(
                result.error?.includes("list_files was never called") ?? false,
                "no-list: error identifies missing list_files",
            );
        }

        // =====================================================================
        // 3. read_file never called -> fail
        // =====================================================================
        {
            const notesDir = join(tmp.path, "notes-no-read");
            seedNotesDir(notesDir);
            const outputDir = join(tmp.path, "out-no-read");

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "list_files", { pattern: "**/*.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "final_answer", {
                        output: {
                            summary: "Listed but did not read.",
                            files_analyzed: [],
                        },
                    }),
                ]),
            ]);

            const result = await runNotesDigest({
                notesDir,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 1, "no-read: exit 1");
            check(
                result.error?.includes("read_file was never called") ?? false,
                "no-read: error identifies missing read_file",
            );
        }

        // =====================================================================
        // 4. No structured output (agent hits maxSteps) -> fail
        // =====================================================================
        {
            const notesDir = join(tmp.path, "notes-maxsteps");
            seedNotesDir(notesDir);
            const outputDir = join(tmp.path, "out-maxsteps");

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "list_files", { pattern: "**/*.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "read_file", { path: "note1.md" }),
                ]),
                // Two tool calls fill maxSteps=2; no final_answer is produced.

            ]);

            const result = await runNotesDigest({
                notesDir,
                outputDir,
                llmClient: client,
                skipMemory: true,
                maxSteps: 2,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 1, "maxsteps: exit 1");
            check(
                result.error?.includes("maxSteps") ?? false,
                "maxsteps: error mentions maxSteps",
            );
        }

        // =====================================================================
        // 5. files_analyzed > maxFiles -> fail
        // =====================================================================
        {
            const notesDir = join(tmp.path, "notes-toomany");
            seedNotesDir(notesDir);
            const outputDir = join(tmp.path, "out-toomany");

            const files: Array<{
                source_file: string;
                summary: string;
                key_points: string[];
            }> = [];
            for (let i = 1; i <= 4; i += 1) {
                files.push({
                    source_file: `note${i}.md`,
                    summary: `Note ${i}.`,
                    key_points: [],
                });
            }

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "list_files", { pattern: "**/*.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "read_file", { path: "note1.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c3", "final_answer", {
                        output: { summary: "Too many.", files_analyzed: files },
                    }),
                ]),
            ]);

            const result = await runNotesDigest({
                notesDir,
                outputDir,
                llmClient: client,
                skipMemory: true,
                maxFiles: 2,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 1, "too-many: exit 1");
            check(
                result.error?.includes("maxFiles is 2") ?? false,
                "too-many: error mentions maxFiles",
            );
        }

        // =====================================================================
        // 6. source_file mismatch -> warn, still exit 0
        // =====================================================================
        {
            const notesDir = join(tmp.path, "notes-mismatch");
            seedNotesDir(notesDir);
            const outputDir = join(tmp.path, "out-mismatch");

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "list_files", { pattern: "**/*.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "read_file", { path: "note1.md" }),
                ]),
                // final_answer references note2.md, which was NOT read.
                toolCallResponse([
                    makeToolCall("c3", "final_answer", {
                        output: {
                            summary: "One real, one hallucinated.",
                            files_analyzed: [
                                {
                                    source_file: "note1.md",
                                    summary: "Read.",
                                    key_points: [],
                                },
                                {
                                    source_file: "note2.md",
                                    summary: "Not actually read.",
                                    key_points: [],
                                },
                            ],
                        },
                    }),
                ]),
            ]);

            const result = await runNotesDigest({
                notesDir,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 0, "mismatch: exit 0");
            checkEqual(result.warnings.length, 1, "mismatch: exactly one warning");
            check(
                result.warnings[0]?.includes("note2.md") ?? false,
                "mismatch: warning mentions the missing file",
            );
            check(
                result.warnings[0]?.includes("was not read via read_file") ?? false,
                "mismatch: warning explains the issue",
            );
            // Artifacts still written.
            check(result.jsonPath !== null, "mismatch: artifacts still written");
        }

        // =====================================================================
        // 7. Missing notesDir -> exit 2
        // =====================================================================
        {
            const result = await runNotesDigest({
                notesDir: join(tmp.path, "does-not-exist"),
                llmClient: new ScriptedClient([]),
                skipMemory: true,
            });
            checkEqual(result.exitCode, 2, "missing-notes: exit 2");
            check(
                result.error?.includes("not found") ?? false,
                "missing-notes: error mentions not found",
            );
        }

        // =====================================================================
        // 8. maxFiles <= 0 -> exit 2
        // =====================================================================
        {
            const notesDir = join(tmp.path, "notes-badmax");
            seedNotesDir(notesDir);
            const result = await runNotesDigest({
                notesDir,
                llmClient: new ScriptedClient([]),
                skipMemory: true,
                maxFiles: 0,
            });
            checkEqual(result.exitCode, 2, "bad-maxfiles: exit 2");
            check(
                result.error?.includes("maxFiles") ?? false,
                "bad-maxfiles: error mentions maxFiles",
            );
        }

        // =====================================================================
        // 9. Prompt instructions include required tools and constraints
        // =====================================================================
        {
            const notesDir = join(tmp.path, "notes-prompt");
            seedNotesDir(notesDir);
            const outputDir = join(tmp.path, "out-prompt");

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "list_files", { pattern: "**/*.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "read_file", { path: "note1.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c3", "final_answer", {
                        output: {
                            summary: "Summary.",
                            files_analyzed: [
                                { source_file: "note1.md", summary: "S.", key_points: [] },
                            ],
                        },
                    }),
                ]),
            ]);

            await runNotesDigest({
                notesDir,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            const firstCall = client.calls[0];
            const instructions = (firstCall?.instructions ?? []).join("\n");
            check(instructions.includes("list_files"), "prompt: mentions list_files");
            check(instructions.includes("read_file"), "prompt: mentions read_file");
            check(
                instructions.includes("final_answer"),
                "prompt: mentions final_answer",
            );
            check(
                instructions.includes("20"),
                "prompt: mentions default maxFiles=20",
            );
            // toolChoice should be "required" because outputType is set.
            checkEqual(
                firstCall?.toolChoice,
                "required",
                "prompt: toolChoice is required",
            );
        }

        // =====================================================================
        // 10. MCP spawn failure -> exit 1 with clean error
        // =====================================================================
        {
            const notesDir = join(tmp.path, "notes-spawnfail");
            seedNotesDir(notesDir);
            const outputDir = join(tmp.path, "out-spawnfail");

            const originalCommand = process.env.MCP_SERVER_COMMAND;
            process.env.MCP_SERVER_COMMAND = "/nonexistent-tsagent-notes-digest";
            try {
                const result = await runNotesDigest({
                    notesDir,
                    outputDir,
                    llmClient: new ScriptedClient([]),
                    skipMemory: true,
                });
                checkEqual(result.exitCode, 1, "spawn-fail: exit 1");
                check(
                    result.error?.includes("MCP server failed to start") ?? false,
                    "spawn-fail: error mentions MCP",
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
        // 11. keepOnFailure preserves the output dir on failure
        // =====================================================================
        {
            const notesDir = join(tmp.path, "notes-keep");
            seedNotesDir(notesDir);
            const outputDir = join(tmp.path, "out-keep");

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "list_files", { pattern: "**/*.md" }),
                ]),
                // No read_file, no final_answer -> failure.
            ]);

            const result = await runNotesDigest({
                notesDir,
                outputDir,
                llmClient: client,
                skipMemory: true,
                maxSteps: 2,
                keepOnFailure: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 1, "keep: exit 1");
            // Log file exists.
            let logExists = true;
            try {
                readFileSync(join(outputDir, "run.log.jsonl"));
            } catch {
                logExists = false;
            }
            check(logExists, "keep: output dir preserved");
        }

        // =====================================================================
        // 12. Quota exhausted -> exit 3
        // =====================================================================
        {
            const notesDir = join(tmp.path, "notes-quota");
            seedNotesDir(notesDir);
            const outputDir = join(tmp.path, "out-quota");

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

            const result = await runNotesDigest({
                notesDir,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 3, "quota: exit 3");
        }

        // =====================================================================
        // 13. CLI parse: --approve --deny conflict -> exit 2
        // =====================================================================
        {
            const { spawnSync } = await import("node:child_process");
            const mainTsPath = join(
                process.cwd(),
                "src",
                "workflows",
                "notes-digest.ts",
            );

            const r = spawnSync(
                process.execPath,
                [
                    "--import",
                    "tsx",
                    mainTsPath,
                    "--notes-dir",
                    "/tmp/nonexistent-notes",
                    "--approve",
                    "--deny",
                ],
                { encoding: "utf8", timeout: 20_000 },
            );
            checkEqual(r.status, 2, "cli/conflict: exit 2");
            check(
                typeof r.stderr === "string" && r.stderr.includes("mutually exclusive"),
                "cli/conflict: message",
            );

            const noDir = spawnSync(
                process.execPath,
                ["--import", "tsx", mainTsPath],
                { encoding: "utf8", timeout: 20_000 },
            );
            checkEqual(noDir.status, 2, "cli/no-notes-dir: exit 2");
        }

        // =====================================================================
        // 14. Digest round-trip: JSON parses to the same object as `digest`
        // =====================================================================
        {
            const notesDir = join(tmp.path, "notes-roundtrip");
            seedNotesDir(notesDir);
            const outputDir = join(tmp.path, "out-roundtrip");

            const payload: NoteDigest = {
                summary: "Round-trip test.",
                files_analyzed: [
                    {
                        source_file: "note1.md",
                        summary: "Note 1 contents.",
                        key_points: ["a", "b"],
                    },
                ],
            };

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "list_files", { pattern: "**/*.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "read_file", { path: "note1.md" }),
                ]),
                toolCallResponse([
                    makeToolCall("c3", "final_answer", { output: payload }),
                ]),
            ]);

            const result = await runNotesDigest({
                notesDir,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 0, "roundtrip: exit 0");
            checkEqual(result.digest, payload, "roundtrip: digest matches payload");
            const jsonContent = JSON.parse(
                readFileSync(result.jsonPath!, "utf8"),
            ) as NoteDigest;
            checkEqual(jsonContent, payload, "roundtrip: JSON artifact round-trips");
        }
    } finally {
        // Cleanup
        try {
            const { rmSync } = await import("node:fs");
            rmSync(tmp.path, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }
});