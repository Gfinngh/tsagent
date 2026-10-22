#!/usr/bin/env node
/**
 * Notes digest workflow.
 *
 * Takes a directory of notes (markdown by default) and produces a
 * structured digest:
 *   - `outputDir/digest.json` — the raw structured output
 *   - `outputDir/digest.md`   — a rendered markdown version
 *
 * Both artifacts are written atomically (`.tmp` + `rename`), so a crash
 * mid-write never leaves a partially-written file.
 *
 * Agent contract:
 *   - `list_files` and `read_file` are both required.
 *   - The agent produces the digest via `final_answer` (structured output).
 *   - `files_analyzed.length` must be ≤ `maxFiles`.
 *   - Each `source_file` should appear in the set of paths the agent
 *     actually read via `read_file`. Mismatches are warnings, not failures.
 *
 * Exit codes:
 *   0  success
 *   1  runtime failure (invariant violation, artifact write failure, MCP
 *      spawn failure, LLM error, etc.)
 *   2  usage error (missing notesDir, invalid flag combination, etc.)
 *   3  LLM quota exhausted
 */

import { Command, CommanderError } from "commander";
import { config as loadEnv } from "dotenv";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { Agent } from "../agent/agent.js";
import { McpConnection, loadMcpTools } from "../agent/client.js";
import { ExecutionContext } from "../agent/context.js";
import { JsonlEventLog } from "../agent/event-log.js";
import type { LlmClientProtocol } from "../agent/llm.js";
import {
    MemoryStore,
    makeMemoryTools,
    type MemoryRow,
} from "../agent/memory.js";
import type { ToolCall } from "../agent/schemas.js";
import type { BaseTool } from "../agent/tools/base.js";
import {
    buildDefaultFallbackChain,
    defaultWorkflowConfirm,
    errorMessage,
    exitCodeFor,
    spawnMcpConnection,
    timestamp,
    toolCallNames,
    toolCallPaths,
    writeAtomically,
} from "./_shared.js";

// =========================================================================
// Structured output schema
// =========================================================================

export const NoteDigestSchema = z.object({
    summary: z.string().describe("One-paragraph overview of all the notes."),
    files_analyzed: z
        .array(
            z.object({
                source_file: z
                    .string()
                    .describe("Exact relative path of the note file."),
                summary: z
                    .string()
                    .describe("One-paragraph summary of this file."),
                key_points: z
                    .array(z.string())
                    .default([])
                    .describe("Key bullet points extracted from this file."),
            }),
        )
        .describe("One entry per note file that was actually analyzed."),
});

export type NoteDigest = z.infer<typeof NoteDigestSchema>;

// =========================================================================
// Public types
// =========================================================================

export interface NotesDigestOptions {
    /** Directory containing the notes. Must exist. */
    notesDir: string;
    /** Default: `runs/digests/<timestamp>/` */
    outputDir?: string;
    /** Glob pattern for `list_files`. Default: `**\/*.md` */
    pattern?: string;
    /** Hard cap on `files_analyzed.length`. Default: 20. */
    maxFiles?: number;
    memoryPath?: string;
    memoryStore?: MemoryStore;
    skipMemory?: boolean;
    llmClient?: LlmClientProtocol;
    model?: string;
    maxSteps?: number;
    allowDangerous?: boolean;
    keepOnFailure?: boolean;
    confirmToolCall?: (
        toolCall: ToolCall,
        tool: BaseTool,
    ) => boolean | Promise<boolean>;
    connectionFactory?: (workspaceRoot: string) => Promise<McpConnection>;
}

export interface NotesDigestResult {
    exitCode: 0 | 1 | 2 | 3;
    notesDir: string;
    outputDir: string;
    jsonPath: string | null;
    markdownPath: string | null;
    digest: NoteDigest | null;
    error: string | null;
    warnings: string[];
    context: ExecutionContext | null;
}

const DEFAULT_PATTERN = "**/*.md";
const DEFAULT_MAX_FILES = 20;

// =========================================================================
// Entry point
// =========================================================================

export async function runNotesDigest(
    options: NotesDigestOptions,
): Promise<NotesDigestResult> {
    const notesDir = resolve(options.notesDir);

    // 1. Validate notesDir before doing anything else.
    if (!existsSync(notesDir)) {
        return fail(notesDir, "", `notes dir not found: ${notesDir}`, 2, []);
    }
    try {
        if (!statSync(notesDir).isDirectory()) {
            return fail(
                notesDir,
                "",
                `notes dir is not a directory: ${notesDir}`,
                2,
                [],
            );
        }
    } catch (error) {
        return fail(notesDir, "", errorMessage(error), 2, []);
    }

    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    if (!Number.isFinite(maxFiles) || maxFiles < 1) {
        return fail(
            notesDir,
            "",
            `maxFiles must be a positive integer (got ${String(maxFiles)})`,
            2,
            [],
        );
    }
    const pattern = options.pattern ?? DEFAULT_PATTERN;

    const outputDir = resolve(
        options.outputDir ?? join("runs", "digests", timestamp()),
    );
    try {
        mkdirSync(outputDir, { recursive: true });
    } catch (error) {
        return fail(
            notesDir,
            outputDir,
            `cannot create output dir: ${errorMessage(error)}`,
            1,
            [],
        );
    }

    const logPath = join(outputDir, "run.log.jsonl");
    const log = new JsonlEventLog(logPath, { fsync: true });

    let result: NotesDigestResult;
    try {
        result = await runInternal(options, notesDir, outputDir, pattern, maxFiles, log);
    } catch (error) {
        result = fail(
            notesDir,
            outputDir,
            errorMessage(error),
            exitCodeFor(error),
            [],
        );
    } finally {
        log.close();
    }

    if (result.exitCode !== 0 && options.keepOnFailure !== true) {
        try {
            rmSync(outputDir, { recursive: true, force: true });
        } catch (error) {
            process.stderr.write(
                `[notes-digest] cleanup failed: ${errorMessage(error)}\n`,
            );
        }
    }

    return result;
}

// =========================================================================
// Internal orchestration
// =========================================================================

async function runInternal(
    options: NotesDigestOptions,
    notesDir: string,
    outputDir: string,
    pattern: string,
    maxFiles: number,
    log: JsonlEventLog,
): Promise<NotesDigestResult> {
    // ----- Memory -----
    const memory = resolveMemoryStore(options);
    const memoryRecall = memory === null ? null : recallSafely(memory, basename(notesDir));
    const memoryTools = memory === null ? [] : makeMemoryTools(memory);

    // ----- MCP -----
    let connection: McpConnection;
    try {
        connection = await openConnection(options, notesDir);
    } catch (error) {
        return fail(
            notesDir,
            outputDir,
            `MCP server failed to start: ${errorMessage(error)}`,
            1,
            [],
        );
    }

    try {
        const mcpTools = await loadMcpTools(connection);
        const allTools: BaseTool[] = [...mcpTools, ...memoryTools];

        let llmClient: LlmClientProtocol;
        if (options.llmClient !== undefined) {
            llmClient = options.llmClient;
        } else {
            try {
                llmClient = buildDefaultFallbackChain(options.model);
            } catch (error) {
                return fail(notesDir, outputDir, errorMessage(error), 1, []);
            }
        }

        const confirm =
            options.confirmToolCall ??
            defaultWorkflowConfirm(options.allowDangerous === true);

        const instructions = [
            buildInstructions(pattern, maxFiles),
        ];

        const agent = new Agent({
            llmClient,
            tools: allTools,
            instructions,
            outputType: NoteDigestSchema,
            confirmToolCall: confirm,
            allowDangerous: options.allowDangerous === true,
            ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        });

        const userMessage = composeUserMessage(
            basename(notesDir),
            pattern,
            maxFiles,
            memoryRecall,
        );

        const agentResult = await agent.run(userMessage, {
            onEvent: (event) => log.append(event),
        });

        return finalizeRun(agentResult, notesDir, outputDir, maxFiles, memory);
    } finally {
        await connection.close();
        if (memory !== null && options.memoryStore === undefined) {
            try {
                memory.close();
            } catch {
                /* ignore */
            }
        }
    }
}

// =========================================================================
// Post-run validation + artifact writing
// =========================================================================

function finalizeRun(
    agentResult: Awaited<ReturnType<Agent["run"]>>,
    notesDir: string,
    outputDir: string,
    maxFiles: number,
    memory: MemoryStore | null,
): NotesDigestResult {
    const warnings: string[] = [];
    const context = agentResult.context;
    const events = context.events;

    // 1. Both required tools must have been called.
    const called = toolCallNames(events);
    if (!called.has("list_files")) {
        return fail(
            notesDir,
            outputDir,
            "workflow invariant violated: list_files was never called",
            1,
            warnings,
        );
    }
    if (!called.has("read_file")) {
        return fail(
            notesDir,
            outputDir,
            "workflow invariant violated: read_file was never called",
            1,
            warnings,
        );
    }

    // 2. The agent must have produced a structured final result.
    const final = agentResult.finalResult;
    if (final === null) {
        return fail(
            notesDir,
            outputDir,
            agentResult.stoppedByMaxSteps
                ? "agent stopped by maxSteps without producing a digest"
                : "agent ended without a structured digest",
            1,
            warnings,
        );
    }
    if (final.kind !== "structured") {
        return fail(
            notesDir,
            outputDir,
            `expected structured digest, got ${final.kind}`,
            1,
            warnings,
        );
    }

    // 3. Validate the digest shape. The agent already validated on the
    //    final_answer path, but re-parse defensively so we own the type.
    const parsed = NoteDigestSchema.safeParse(final.output);
    if (!parsed.success) {
        return fail(
            notesDir,
            outputDir,
            `digest does not match expected schema: ${parsed.error.message}`,
            1,
            warnings,
        );
    }
    const digest = parsed.data;

    // 4. `files_analyzed.length` must not exceed `maxFiles`.
    if (digest.files_analyzed.length > maxFiles) {
        return fail(
            notesDir,
            outputDir,
            `digest lists ${digest.files_analyzed.length} files_analyzed, but maxFiles is ${maxFiles}`,
            1,
            warnings,
        );
    }

    // 5. `source_file` validation — warn-only.
    const readPaths = toolCallPaths(events, "read_file");
    for (let i = 0; i < digest.files_analyzed.length; i += 1) {
        const entry = digest.files_analyzed[i]!;
        if (!readPaths.has(entry.source_file)) {
            const warning =
                `files_analyzed[${i}].source_file='${entry.source_file}' ` +
                `was not read via read_file during this run`;
            warnings.push(warning);
            process.stderr.write(`[notes-digest] warning: ${warning}\n`);
        }
    }

    // 6. Write artifacts atomically. Each file is individually atomic (no
    //    partial content on crash); the pair is not atomic together, but
    //    that is the strongest guarantee a two-file layout can offer
    //    without a manifest.
    const jsonPath = join(outputDir, "digest.json");
    const markdownPath = join(outputDir, "digest.md");
    try {
        writeAtomically(jsonPath, JSON.stringify(digest, null, 2) + "\n");
        writeAtomically(markdownPath, renderMarkdown(digest));
    } catch (error) {
        return fail(
            notesDir,
            outputDir,
            `failed to write artifacts: ${errorMessage(error)}`,
            1,
            warnings,
        );
    }

    // 7. Best-effort memory: store the digest summary under a key derived
    //    from the notes dir.
    if (memory !== null) {
        try {
            const key = `digest:${basename(notesDir)}`;
            memory.upsert({
                namespace: "notes-digests",
                key,
                content: digest.summary,
                tags: ["notes-digest"],
            });
        } catch (error) {
            process.stderr.write(
                `[notes-digest] memory store failed (continuing): ${errorMessage(error)}\n`,
            );
        }
    }

    return {
        exitCode: 0,
        notesDir,
        outputDir,
        jsonPath,
        markdownPath,
        digest,
        error: null,
        warnings,
        context,
    };
}

// =========================================================================
// Connection / memory
// =========================================================================

async function openConnection(
    options: NotesDigestOptions,
    workspaceRoot: string,
): Promise<McpConnection> {
    if (options.connectionFactory !== undefined) {
        return options.connectionFactory(workspaceRoot);
    }
    return spawnMcpConnection({ workspaceRoot });
}

function resolveMemoryStore(options: NotesDigestOptions): MemoryStore | null {
    if (options.skipMemory === true) return null;
    if (options.memoryStore !== undefined) return options.memoryStore;
    const path =
        options.memoryPath ||
        process.env.TSAGENT_MEMORY_DB ||
        join(".memory", "memory.sqlite3");
    return new MemoryStore(path);
}

function recallSafely(store: MemoryStore, notesName: string): string | null {
    try {
        const rows: MemoryRow[] = store.search(notesName, {
            namespace: "notes-digests",
            limit: 1,
        });
        if (rows.length === 0) return null;
        return rows.map((r) => `- ${r.key}: ${r.content}`).join("\n");
    } catch (error) {
        process.stderr.write(
            `[notes-digest] memory recall failed (continuing): ${errorMessage(error)}\n`,
        );
        return null;
    }
}

// =========================================================================
// Prompt
// =========================================================================

function buildInstructions(pattern: string, maxFiles: number): string {
    return [
        "You are a note-digesting assistant. Read every note file in the workspace and produce a structured digest.",
        "",
        "You MUST:",
        `1. Call \`list_files\` with \`pattern: "${pattern}"\` to enumerate note files.`,
        `2. Call \`read_file\` for each note file you want to analyze.`,
        `   Analyze at most ${maxFiles} files.`,
        "3. Produce a structured digest by calling `final_answer`. The `output` object MUST have:",
        "   - `summary`: a one-paragraph overview of all the notes.",
        "   - `files_analyzed`: one entry per note file you actually read. Each entry MUST have:",
        "       - `source_file`: the exact relative path returned by `list_files`.",
        "       - `summary`: a one-paragraph summary of that file.",
        "       - `key_points`: an array of key bullet points extracted from that file.",
        "4. Do not skip any file you actually read, and do not include files you did not read.",
    ].join("\n");
}

function composeUserMessage(
    notesName: string,
    pattern: string,
    maxFiles: number,
    memoryRecall: string | null,
): string {
    const lines: string[] = [];
    if (memoryRecall !== null) {
        lines.push("Prior digest summary for these notes (may be stale; cross-check):");
        lines.push(memoryRecall);
        lines.push("");
    }
    lines.push(`Notes directory: ${notesName}`);
    lines.push(`Pattern: ${pattern}`);
    lines.push(`Maximum files to analyze: ${maxFiles}`);
    lines.push("");
    lines.push(
        "Enumerate, read, and digest the notes. Emit the final structured answer with `final_answer`.",
    );
    return lines.join("\n");
}

// =========================================================================
// Markdown rendering
// =========================================================================

function renderMarkdown(digest: NoteDigest): string {
    const lines: string[] = ["# Notes Digest", "", digest.summary, "", "## Files", ""];
    for (const entry of digest.files_analyzed) {
        lines.push(`### \`${entry.source_file}\``);
        lines.push("");
        lines.push(entry.summary);
        if (entry.key_points.length > 0) {
            lines.push("");
            for (const point of entry.key_points) {
                lines.push(`- ${point}`);
            }
        }
        lines.push("");
    }
    return lines.join("\n");
}

// =========================================================================
// Failure helper
// =========================================================================

function fail(
    notesDir: string,
    outputDir: string,
    message: string,
    exitCode: 1 | 2 | 3,
    warnings: string[],
): NotesDigestResult {
    return {
        exitCode,
        notesDir,
        outputDir,
        jsonPath: null,
        markdownPath: null,
        digest: null,
        error: message,
        warnings,
        context: null,
    };
}

// =========================================================================
// CLI entry
// =========================================================================

async function cliMain(): Promise<number> {
    loadEnv();

    const program = new Command();
    program
        .name("tsagent-notes-digest")
        .description("Produce a structured digest of a notes directory.")
        .requiredOption("--notes-dir <path>", "directory containing the notes")
        .option("--output-dir <path>", "output directory")
        .option("--pattern <glob>", "glob for list_files", DEFAULT_PATTERN)
        .option("--max-files <n>", "maximum files to analyze", (v) => parseInt(v, 10))
        .option("--model <name>", "primary model")
        .option("--max-steps <n>", "max agent steps", (v) => parseInt(v, 10))
        .option("--memory-db <path>", "SQLite path for memory")
        .option("--skip-memory", "disable memory recall and storage")
        .option("--allow-dangerous", "allow dangerous tools")
        .option("--keep-on-failure", "keep the output dir on failure")
        .option("--approve", "auto-approve all confirmations")
        .option("--deny", "auto-deny all confirmations")
        .exitOverride();

    try {
        program.parse(process.argv);
    } catch (error) {
        if (error instanceof CommanderError) {
            return error.exitCode === 0 ? 0 : 2;
        }
        throw error;
    }

    const opts = program.opts<{
        notesDir: string;
        outputDir?: string;
        pattern: string;
        maxFiles?: number;
        model?: string;
        maxSteps?: number;
        memoryDb?: string;
        skipMemory?: boolean;
        allowDangerous?: boolean;
        keepOnFailure?: boolean;
        approve?: boolean;
        deny?: boolean;
    }>();

    if (opts.approve === true && opts.deny === true) {
        process.stderr.write(
            "[notes-digest] --approve and --deny are mutually exclusive\n",
        );
        return 2;
    }

    let confirmToolCall:
        | ((toolCall: ToolCall, tool: BaseTool) => boolean | Promise<boolean>)
        | undefined;
    if (opts.approve === true) confirmToolCall = () => true;
    else if (opts.deny === true) confirmToolCall = () => false;

    const result = await runNotesDigest({
        notesDir: opts.notesDir,
        pattern: opts.pattern,
        ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
        ...(opts.maxFiles !== undefined ? { maxFiles: opts.maxFiles } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        ...(opts.memoryDb !== undefined ? { memoryPath: opts.memoryDb } : {}),
        ...(opts.skipMemory === true ? { skipMemory: true } : {}),
        ...(opts.allowDangerous === true ? { allowDangerous: true } : {}),
        ...(opts.keepOnFailure === true ? { keepOnFailure: true } : {}),
        ...(confirmToolCall !== undefined ? { confirmToolCall } : {}),
    });

    if (result.error !== null) {
        process.stderr.write(`[notes-digest] ${result.error}\n`);
    }
    if (result.jsonPath !== null) {
        process.stdout.write(`${result.jsonPath}\n`);
    }
    if (result.markdownPath !== null) {
        process.stdout.write(`${result.markdownPath}\n`);
    }
    return result.exitCode;
}

const invokedDirectly =
    typeof process.argv[1] === "string" &&
    import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
    cliMain().then(
        (code) => process.exit(code),
        (error) => {
            process.stderr.write(`[notes-digest] fatal: ${errorMessage(error)}\n`);
            process.exit(1);
        },
    );
}