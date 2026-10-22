#!/usr/bin/env node
/**
 * Research brief workflow.
 *
 * 1. Recall prior research from memory (graceful: any memory failure is
 *    logged but never fails the run).
 * 2. Spawn an MCP server with `WORKSPACE_ROOT = outputDir`.
 * 3. Run the agent with `search_web` + `write_file` required, plus the
 *    memory tools.
 * 4. Validate the produced `brief.md`: exists at the exact relative path,
 *    contains all four required sections, and the run's events include a
 *    `search_web` call and a `write_file` call.
 * 5. Extract `## Summary` and store it under `key = slugify(topic)` in
 *    memory (graceful: failure logged, still returns 0).
 * 6. On failure, delete `outputDir` unless `keepOnFailure`.
 */

import { Command, CommanderError } from "commander";
import { config as loadEnv } from "dotenv";
import { mkdirSync, rmSync } from "node:fs";
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
import type { BaseTool } from "../agent/tools/base.js";
import type { ToolCall } from "../agent/schemas.js";
import {
    FRESH_BRIEF_INSTRUCTIONS,
    buildDefaultFallbackChain,
    defaultWorkflowConfirm,
    errorMessage,
    exitCodeFor,
    slugify,
    spawnMcpConnection,
    timestamp,
    validateBriefOutcome,
} from "./_shared.js";

// =========================================================================
// Public types
// =========================================================================

export interface ResearchBriefOptions {
    topic: string;
    outputDir?: string;
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
    connection?: McpConnection;
}

export interface ResearchBriefResult {
    exitCode: 0 | 1 | 2 | 3;
    outputDir: string;
    briefPath: string | null;
    memoryKey: string | null;
    summary: string | null;
    error: string | null;
    context: ExecutionContext | null;
}

// =========================================================================
// Entry point
// =========================================================================

export async function runResearchBrief(
    options: ResearchBriefOptions,
): Promise<ResearchBriefResult> {
    if (options.topic.trim().length === 0) {
        return fail(null, "topic is empty", 2);
    }

    const slug = slugify(options.topic);
    const outputDir = resolve(
        options.outputDir ??
        join("runs", "briefs", `${slug}-${timestamp()}`),
    );

    try {
        mkdirSync(outputDir, { recursive: true });
    } catch (error) {
        return fail(outputDir, `cannot create output dir: ${errorMessage(error)}`, 1);
    }

    const logPath = join(outputDir, "run.log.jsonl");
    // fsync: true — consistent durability across all logs. The overhead is
    // negligible for typical run lengths, and treating "logs are crash-safe"
    // as an invariant prevents accidental weakening later.
    const log = new JsonlEventLog(logPath, { fsync: true });

    let result: ResearchBriefResult;
    try {
        result = await runInternal(options, outputDir, slug, log);
    } catch (error) {
        result = fail(outputDir, errorMessage(error), exitCodeFor(error));
    } finally {
        log.close();
    }

    if (result.exitCode !== 0 && options.keepOnFailure !== true) {
        try {
            rmSync(outputDir, { recursive: true, force: true });
        } catch (error) {
            process.stderr.write(
                `[research-brief] cleanup failed: ${errorMessage(error)}\n`,
            );
        }
    }

    return result;
}

// =========================================================================
// Internal orchestration
// =========================================================================

async function runInternal(
    options: ResearchBriefOptions,
    outputDir: string,
    slug: string,
    log: JsonlEventLog,
): Promise<ResearchBriefResult> {
    const memory = resolveMemoryStore(options);
    const priorContext = memory === null ? null : recallSafely(memory, options.topic);
    const memoryTools = memory === null ? [] : makeMemoryTools(memory);

    let connection: McpConnection;
    let ownsConnection: boolean;
    if (options.connection !== undefined) {
        connection = options.connection;
        ownsConnection = false;
    } else {
        try {
            connection = await spawnMcpConnection({ workspaceRoot: outputDir });
            ownsConnection = true;
        } catch (error) {
            return fail(
                outputDir,
                `MCP server failed to start: ${errorMessage(error)}`,
                1,
            );
        }
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
                return fail(outputDir, errorMessage(error), 1);
            }
        }

        const confirm =
            options.confirmToolCall ??
            defaultWorkflowConfirm(options.allowDangerous === true);

        const agent = new Agent({
            llmClient,
            tools: allTools,
            instructions: [FRESH_BRIEF_INSTRUCTIONS],
            confirmToolCall: confirm,
            allowDangerous: options.allowDangerous === true,
            ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        });

        const userMessage = composeUserMessage(options.topic, priorContext);
        const agentResult = await agent.run(userMessage, {
            onEvent: (event) => log.append(event),
        });

        const validation = validateBriefOutcome(agentResult.context, outputDir);
        if (!validation.valid) {
            return {
                exitCode: 1,
                outputDir,
                briefPath: null,
                memoryKey: null,
                summary: null,
                error: validation.reason,
                context: agentResult.context,
            };
        }

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
                    `[research-brief] failed to store summary: ${errorMessage(error)}\n`,
                );
            }
        }

        return {
            exitCode: 0,
            outputDir,
            briefPath: validation.briefPath,
            memoryKey,
            summary: validation.summary,
            error: null,
            context: agentResult.context,
        };
    } finally {
        if (ownsConnection) {
            await connection.close();
        }
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
// Memory
// =========================================================================

function resolveMemoryStore(options: ResearchBriefOptions): MemoryStore | null {
    if (options.skipMemory === true) return null;
    if (options.memoryStore !== undefined) return options.memoryStore;
    // `??` does not fall back on empty strings. `.env` commonly has
    // `TSAGENT_MEMORY_DB=` set to nothing, which would resolve to cwd and
    // make `new Database(cwd)` fail with "unable to open database file".
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
            `[research-brief] memory recall failed (continuing without prior context): ${errorMessage(error)}\n`,
        );
        return null;
    }
}

// =========================================================================
// Prompt
// =========================================================================

function composeUserMessage(topic: string, priorContext: string | null): string {
    const lines: string[] = [];
    if (priorContext !== null) {
        lines.push("Prior research from memory (may be stale; cross-check):");
        lines.push(priorContext);
        lines.push("");
    }
    lines.push(`Topic: ${topic}`);
    lines.push("");
    lines.push(
        `Write the research brief to \`brief.md\` and confirm when done.`,
    );
    return lines.join("\n");
}

// =========================================================================
// Failure helper
// =========================================================================

function fail(
    outputDir: string | null,
    message: string,
    exitCode: 1 | 2 | 3,
): ResearchBriefResult {
    return {
        exitCode,
        outputDir: outputDir ?? "",
        briefPath: null,
        memoryKey: null,
        summary: null,
        error: message,
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
        .name("tsagent-research-brief")
        .description("Research a topic and produce a structured markdown brief.")
        .argument("<topic>", "topic to research")
        .option("--output-dir <path>", "output directory")
        .option("--model <name>", "primary model")
        .option("--max-steps <n>", "max agent steps", (v) => parseInt(v, 10))
        .option("--memory-db <path>", "SQLite path for memory")
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

    const topic = program.args[0] as string;
    const opts = program.opts<{
        outputDir?: string;
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
            "[research-brief] --approve and --deny are mutually exclusive\n",
        );
        return 2;
    }

    let confirmToolCall:
        | ((toolCall: ToolCall, tool: BaseTool) => boolean | Promise<boolean>)
        | undefined;
    if (opts.approve === true) confirmToolCall = () => true;
    else if (opts.deny === true) confirmToolCall = () => false;

    const result = await runResearchBrief({
        topic,
        ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        ...(opts.memoryDb !== undefined ? { memoryPath: opts.memoryDb } : {}),
        ...(opts.allowDangerous === true ? { allowDangerous: true } : {}),
        ...(opts.keepOnFailure === true ? { keepOnFailure: true } : {}),
        ...(confirmToolCall !== undefined ? { confirmToolCall } : {}),
    });

    if (result.error !== null) {
        process.stderr.write(`[research-brief] ${result.error}\n`);
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
            process.stderr.write(`[research-brief] fatal: ${errorMessage(error)}\n`);
            process.exit(1);
        },
    );
}