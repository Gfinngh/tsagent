#!/usr/bin/env node
/**
 * Iterative brief workflow.
 *
 * Versions live under `<baseDir>/v1/`, `<baseDir>/v2/`, etc. Each version
 * dir is a full workspace with `brief.md` and `run.log.jsonl`.
 *
 * Fresh mode (no `refinement`): create `v1`. If any version already
 * exists, error (exit 2) — fresh never nukes prior work.
 *
 * Refine mode (`refinement` set): find the latest version, rehydrate its
 * context from `run.log.jsonl`, call `Agent.resume` with the refinement
 * message, and write `v(N+1)`. The new version's log is seeded with all
 * of `vN`'s events, so the log is a complete lineage of the run.
 *
 * Validation: same as research-brief, but restricted to the *new* turn —
 * `search_web` and `write_file` must be called during the refinement, not
 * just historically.
 *
 * Cleanup: on failure, `<baseDir>/v<N>` is deleted unless `keepOnFailure`.
 * Prior versions are never touched.
 */

import { Command, CommanderError } from "commander";
import { config as loadEnv } from "dotenv";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
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
    FRESH_BRIEF_INSTRUCTIONS,
    buildDefaultFallbackChain,
    defaultWorkflowConfirm,
    errorMessage,
    exitCodeFor,
    listVersions,
    refineBriefInstructions,
    slugify,
    spawnMcpConnection,
    validateBriefOutcome,
} from "./_shared.js";

// =========================================================================
// Public types
// =========================================================================

export interface IterativeBriefOptions {
    topic: string;
    /** Default: `<project>/runs/briefs/<slug>/` */
    baseDir?: string;
    /** If set, run in refine mode against the latest version. */
    refinement?: string;
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
    /**
     * Injectable connection factory (tests). Called once per version dir;
     * the workflow closes the returned connection.
     */
    connectionFactory?: (workspaceRoot: string) => Promise<McpConnection>;
}

export interface IterativeBriefResult {
    exitCode: 0 | 1 | 2 | 3;
    /** Version number of the version this run produced. 0 on early failure. */
    version: number;
    /** The version dir the run produced. Empty on early failure. */
    versionDir: string;
    /** The base directory (contains v1/, v2/, …). */
    baseDir: string;
    briefPath: string | null;
    memoryKey: string | null;
    summary: string | null;
    error: string | null;
    context: ExecutionContext | null;
    /** Version this run was refined from, or null for fresh runs. */
    refinedFrom: number | null;
}

// =========================================================================
// Entry point
// =========================================================================

export async function runIterativeBrief(
    options: IterativeBriefOptions,
): Promise<IterativeBriefResult> {
    if (options.topic.trim().length === 0) {
        return err(0, "", "", "topic is empty", 2);
    }

    const slug = slugify(options.topic);
    const baseDir = resolve(
        options.baseDir ?? join("runs", "briefs", slug),
    );

    const existing = listVersions(baseDir);
    const isRefine = options.refinement !== undefined;

    let newVersion: number;
    let sourceLogPath: string | null;
    let refinedFrom: number | null;

    if (isRefine) {
        if (existing.length === 0) {
            return err(0, baseDir, "", "cannot refine: no prior version exists", 2);
        }
        const latest = Math.max(...existing);
        const sourceLog = join(baseDir, `v${latest}`, "run.log.jsonl");
        if (!existsSync(sourceLog)) {
            return err(
                0,
                baseDir,
                "",
                `cannot refine: missing log at ${sourceLog}`,
                1,
            );
        }
        newVersion = latest + 1;
        sourceLogPath = sourceLog;
        refinedFrom = latest;
    } else {
        if (existing.length > 0) {
            return err(
                0,
                baseDir,
                "",
                `version(s) already exist (latest: v${Math.max(...existing)}); use refinement or a different --base-dir`,
                2,
            );
        }
        newVersion = 1;
        sourceLogPath = null;
        refinedFrom = null;
    }

    const versionDir = join(baseDir, `v${newVersion}`);
    try {
        mkdirSync(versionDir, { recursive: true });
    } catch (error) {
        return err(
            newVersion,
            baseDir,
            versionDir,
            `cannot create version dir: ${errorMessage(error)}`,
            1,
        );
    }

    const logPath = join(versionDir, "run.log.jsonl");
    // fsync: true — this log is read back by the *next* refine invocation,
    // so crash-safety is load-bearing, not cosmetic.
    const log = new JsonlEventLog(logPath, { fsync: true });

    let result: IterativeBriefResult;
    try {
        result = await runInternal(
            options,
            baseDir,
            versionDir,
            newVersion,
            sourceLogPath,
            refinedFrom,
            slug,
            log,
        );
    } catch (error) {
        result = err(
            newVersion,
            baseDir,
            versionDir,
            errorMessage(error),
            exitCodeFor(error),
        );
    } finally {
        log.close();
    }

    if (result.exitCode !== 0 && options.keepOnFailure !== true) {
        try {
            rmSync(versionDir, { recursive: true, force: true });
        } catch (error) {
            process.stderr.write(
                `[iterative-brief] cleanup failed: ${errorMessage(error)}\n`,
            );
        }
    }

    return result;
}

// =========================================================================
// Internal orchestration
// =========================================================================

async function runInternal(
    options: IterativeBriefOptions,
    baseDir: string,
    versionDir: string,
    version: number,
    sourceLogPath: string | null,
    refinedFrom: number | null,
    slug: string,
    log: JsonlEventLog,
): Promise<IterativeBriefResult> {
    // ----- Rehydrate prior context (refine mode only) -----
    let priorContext: ExecutionContext | null = null;
    let priorEventCount = 0;
    if (sourceLogPath !== null) {
        try {
            priorContext = ExecutionContext.fromLog(sourceLogPath);
            priorEventCount = priorContext.events.length;
        } catch (error) {
            return err(
                version,
                baseDir,
                versionDir,
                `cannot rehydrate prior version: ${errorMessage(error)}`,
                1,
            );
        }
        for (const event of priorContext.events) log.append(event);
    }

    // ----- Memory -----
    const memory = resolveMemoryStore(options);
    const memoryRecall =
        memory === null ? null : recallSafely(memory, options.topic);
    const memoryTools = memory === null ? [] : makeMemoryTools(memory);

    // ----- MCP -----
    let connection: McpConnection;
    try {
        connection = await openConnection(options, versionDir);
    } catch (error) {
        return err(
            version,
            baseDir,
            versionDir,
            `MCP server failed to start: ${errorMessage(error)}`,
            1,
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
                return err(version, baseDir, versionDir, errorMessage(error), 1);
            }
        }

        const confirm =
            options.confirmToolCall ??
            defaultWorkflowConfirm(options.allowDangerous === true);

        const instructions =
            refinedFrom !== null && options.refinement !== undefined
                ? [refineBriefInstructions(options.refinement)]
                : [FRESH_BRIEF_INSTRUCTIONS];

        const agent = new Agent({
            llmClient,
            tools: allTools,
            instructions,
            confirmToolCall: confirm,
            allowDangerous: options.allowDangerous === true,
            ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        });

        // ----- Run -----
        let agentResult;
        if (priorContext !== null) {
            agentResult = await agent.resume(priorContext, {
                userMessage: composeRefineUserMessage(options.refinement ?? ""),
                onEvent: (event) => log.append(event),
            });
        } else {
            agentResult = await agent.run(
                composeFreshUserMessage(options.topic, memoryRecall),
                { onEvent: (event) => log.append(event) },
            );
        }

        // ----- Validate only the new turn -----
        const validation = validateBriefOutcome(
            agentResult.context,
            versionDir,
            { sinceEventIndex: priorEventCount },
        );
        if (!validation.valid) {
            return {
                exitCode: 1,
                version,
                versionDir,
                baseDir,
                briefPath: null,
                memoryKey: null,
                summary: null,
                error: validation.reason,
                context: agentResult.context,
                refinedFrom,
            };
        }

        // ----- Auto-store summary (overwrites prior key = slug) -----
        let memoryKey: string | null = null;
        if (memory !== null && validation.summary !== null) {
            try {
                memory.upsert({
                    namespace: "briefs",
                    key: slug,
                    content: validation.summary,
                    tags: ["research-brief"],
                });
                memoryKey = slug;
            } catch (error) {
                process.stderr.write(
                    `[iterative-brief] failed to store summary: ${errorMessage(error)}\n`,
                );
            }
        }

        return {
            exitCode: 0,
            version,
            versionDir,
            baseDir,
            briefPath: validation.briefPath,
            memoryKey,
            summary: validation.summary,
            error: null,
            context: agentResult.context,
            refinedFrom,
        };
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
// Connection factory
// =========================================================================

async function openConnection(
    options: IterativeBriefOptions,
    workspaceRoot: string,
): Promise<McpConnection> {
    if (options.connectionFactory !== undefined) {
        return options.connectionFactory(workspaceRoot);
    }
    return spawnMcpConnection({ workspaceRoot });
}

// =========================================================================
// Memory
// =========================================================================

function resolveMemoryStore(options: IterativeBriefOptions): MemoryStore | null {
    if (options.skipMemory === true) return null;
    if (options.memoryStore !== undefined) return options.memoryStore;
    const path =
        options.memoryPath ||
        process.env.TSAGENT_MEMORY_DB ||
        join(".memory", "memory.sqlite3");
    return new MemoryStore(path);
}

function recallSafely(store: MemoryStore, topic: string): string | null {
    try {
        const rows: MemoryRow[] = store.search(topic, { limit: 3 });
        if (rows.length === 0) return null;
        return rows.map((r) => `- ${r.key}: ${r.content}`).join("\n");
    } catch (error) {
        process.stderr.write(
            `[iterative-brief] memory recall failed (continuing without prior context): ${errorMessage(error)}\n`,
        );
        return null;
    }
}

// =========================================================================
// Prompt composition
// =========================================================================

function composeFreshUserMessage(topic: string, priorContext: string | null): string {
    const lines: string[] = [];
    if (priorContext !== null) {
        lines.push("Prior research from memory (may be stale; cross-check):");
        lines.push(priorContext);
        lines.push("");
    }
    lines.push(`Topic: ${topic}`);
    lines.push("");
    lines.push(`Write the research brief to \`brief.md\` and confirm when done.`);
    return lines.join("\n");
}

function composeRefineUserMessage(refinement: string): string {
    return [
        "Please refine the brief per the refinement request in your instructions.",
        `Refinement: ${refinement}`,
        "",
        `Write the updated brief to \`brief.md\` in this new workspace and confirm when done.`,
    ].join("\n");
}

// =========================================================================
// Failure helper
// =========================================================================

function err(
    version: number,
    baseDir: string,
    versionDir: string,
    message: string,
    exitCode: 1 | 2 | 3,
): IterativeBriefResult {
    return {
        exitCode,
        version,
        versionDir,
        baseDir,
        briefPath: null,
        memoryKey: null,
        summary: null,
        error: message,
        context: null,
        refinedFrom: null,
    };
}

// =========================================================================
// CLI entry
// =========================================================================

async function cliMain(): Promise<number> {
    loadEnv();

    const program = new Command();
    program
        .name("tsagent-iterative-brief")
        .description(
            "Research a topic and iteratively refine the brief across versions.",
        )
        .argument("<topic>", "topic to research")
        .option("--refine <text>", "refinement request for the latest version")
        .option("--base-dir <path>", "base directory holding v1/, v2/, …")
        .option("--model <name>", "primary model")
        .option("--max-steps <n>", "max agent steps", (v) => parseInt(v, 10))
        .option("--memory-db <path>", "SQLite path for memory")
        .option("--allow-dangerous", "allow dangerous tools")
        .option("--keep-on-failure", "keep the version dir on failure")
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

    const topic = program.args[0] as string;
    const opts = program.opts<{
        refine?: string;
        baseDir?: string;
        model?: string;
        maxSteps?: number;
        memoryDb?: string;
        allowDangerous?: boolean;
        keepOnFailure?: boolean;
        approve?: boolean;
        deny?: boolean;
    }>();

    if (opts.approve === true && opts.deny === true) {
        process.stderr.write(
            "[iterative-brief] --approve and --deny are mutually exclusive\n",
        );
        return 2;
    }

    let confirmToolCall:
        | ((toolCall: ToolCall, tool: BaseTool) => boolean | Promise<boolean>)
        | undefined;
    if (opts.approve === true) confirmToolCall = () => true;
    else if (opts.deny === true) confirmToolCall = () => false;

    const result = await runIterativeBrief({
        topic,
        ...(opts.refine !== undefined ? { refinement: opts.refine } : {}),
        ...(opts.baseDir !== undefined ? { baseDir: opts.baseDir } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        ...(opts.memoryDb !== undefined ? { memoryPath: opts.memoryDb } : {}),
        ...(opts.allowDangerous === true ? { allowDangerous: true } : {}),
        ...(opts.keepOnFailure === true ? { keepOnFailure: true } : {}),
        ...(confirmToolCall !== undefined ? { confirmToolCall } : {}),
    });

    if (result.error !== null) {
        process.stderr.write(`[iterative-brief] ${result.error}\n`);
    }
    if (result.briefPath !== null) {
        process.stdout.write(`${result.briefPath}\n`);
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
            process.stderr.write(`[iterative-brief] fatal: ${errorMessage(error)}\n`);
            process.exit(1);
        },
    );
}