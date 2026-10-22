#!/usr/bin/env node
/**
 * Trip planner workflow.
 *
 * Takes a destination and a day count, produces a structured trip plan:
 *   - `outputDir/plan.json` — the raw structured output
 *   - `outputDir/plan.md`   — a rendered markdown plan
 *
 * Both artifacts are written atomically (`.tmp` + `rename`), so a crash
 * mid-write never leaves a partially-written file.
 *
 * Agent contract:
 *   - `search_web` must be called at least once.
 *   - The plan is produced via `final_answer` (structured output).
 *   - The plan must contain exactly `days` entries under `days`,
 *     numbered `1..N` in order.
 *
 * Exit codes:
 *   0  success
 *   1  runtime failure (invariant violation, artifact write failure, MCP
 *      spawn failure, LLM error, etc.)
 *   2  usage error (missing destination, invalid `days`, bad flags)
 *   3  LLM quota exhausted
 */

import { Command, CommanderError } from "commander";
import { config as loadEnv } from "dotenv";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
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
    slugify,
    spawnMcpConnection,
    timestamp,
    toolCallNames,
    writeAtomically,
} from "./_shared.js";

// =========================================================================
// Structured output schema
// =========================================================================

const ActivitySchema = z.object({
    activity: z.string().describe("Description of the activity."),
    time: z
        .string()
        .nullable()
        .default(null)
        .describe("Optional time hint, e.g. 'morning', '14:00'."),
    notes: z
        .string()
        .nullable()
        .default(null)
        .describe("Optional additional notes for this activity."),
});

const DaySchema = z.object({
    day: z.number().int().positive().describe("Day number starting at 1."),
    title: z.string().describe("Short title for the day."),
    activities: z
        .array(ActivitySchema)
        .min(1)
        .describe("Non-empty list of activities for the day."),
});

export const TripPlanSchema = z.object({
    destination: z.string().describe("Trip destination name."),
    summary: z.string().describe("One-paragraph overview of the trip."),
    days: z
        .array(DaySchema)
        .min(1)
        .describe("One entry per day, numbered 1..N in order."),
    tips: z
        .array(z.string())
        .default([])
        .describe("Optional list of practical tips."),
});

export type TripPlan = z.infer<typeof TripPlanSchema>;
export type TripPlanDay = z.infer<typeof DaySchema>;
export type TripPlanActivity = z.infer<typeof ActivitySchema>;

// =========================================================================
// Public types
// =========================================================================

export interface TripPlannerOptions {
    /** Destination name. Must be non-empty. */
    destination: string;
    /** Number of days. Must be an integer in `[1, MAX_DAYS]`. */
    days: number;
    /** Default: `runs/trips/<slug>-<timestamp>/` */
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
    connectionFactory?: (workspaceRoot: string) => Promise<McpConnection>;
}

export interface TripPlannerResult {
    exitCode: 0 | 1 | 2 | 3;
    destination: string;
    /** The number of days the caller requested. */
    requestedDays: number;
    outputDir: string;
    jsonPath: string | null;
    markdownPath: string | null;
    plan: TripPlan | null;
    error: string | null;
    context: ExecutionContext | null;
}

export const MAX_DAYS = 30;

// =========================================================================
// Entry point
// =========================================================================

export async function runTripPlanner(
    options: TripPlannerOptions,
): Promise<TripPlannerResult> {
    const destination = options.destination.trim();

    // 1. Validate inputs before doing anything else.
    if (destination.length === 0) {
        return fail("", 0, "", "destination is empty", 2);
    }
    if (
        !Number.isFinite(options.days) ||
        !Number.isInteger(options.days) ||
        options.days < 1 ||
        options.days > MAX_DAYS
    ) {
        return fail(
            destination,
            options.days,
            "",
            `days must be an integer in [1, ${MAX_DAYS}] (got ${String(options.days)})`,
            2,
        );
    }

    const slug = slugify(destination);
    const outputDir = resolve(
        options.outputDir ??
        join("runs", "trips", `${slug}-${timestamp()}`),
    );

    try {
        mkdirSync(outputDir, { recursive: true });
    } catch (error) {
        return fail(
            destination,
            options.days,
            outputDir,
            `cannot create output dir: ${errorMessage(error)}`,
            1,
        );
    }

    const logPath = join(outputDir, "run.log.jsonl");
    const log = new JsonlEventLog(logPath, { fsync: true });

    let result: TripPlannerResult;
    try {
        result = await runInternal(options, destination, slug, outputDir, log);
    } catch (error) {
        result = fail(
            destination,
            options.days,
            outputDir,
            errorMessage(error),
            exitCodeFor(error),
        );
    } finally {
        log.close();
    }

    if (result.exitCode !== 0 && options.keepOnFailure !== true) {
        try {
            rmSync(outputDir, { recursive: true, force: true });
        } catch (error) {
            process.stderr.write(
                `[trip-planner] cleanup failed: ${errorMessage(error)}\n`,
            );
        }
    }

    return result;
}

// =========================================================================
// Internal orchestration
// =========================================================================

async function runInternal(
    options: TripPlannerOptions,
    destination: string,
    slug: string,
    outputDir: string,
    log: JsonlEventLog,
): Promise<TripPlannerResult> {
    const memory = resolveMemoryStore(options);
    const memoryRecall = memory === null ? null : recallSafely(memory, destination);
    const memoryTools = memory === null ? [] : makeMemoryTools(memory);

    let connection: McpConnection;
    try {
        connection = await openConnection(options, outputDir);
    } catch (error) {
        return fail(
            destination,
            options.days,
            outputDir,
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
                return fail(
                    destination,
                    options.days,
                    outputDir,
                    errorMessage(error),
                    1,
                );
            }
        }

        const confirm =
            options.confirmToolCall ??
            defaultWorkflowConfirm(options.allowDangerous === true);

        const agent = new Agent({
            llmClient,
            tools: allTools,
            instructions: [buildInstructions(destination, options.days)],
            outputType: TripPlanSchema,
            confirmToolCall: confirm,
            allowDangerous: options.allowDangerous === true,
            ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        });

        const agentResult = await agent.run(
            composeUserMessage(destination, options.days, memoryRecall),
            { onEvent: (event) => log.append(event) },
        );

        return finalizeRun(agentResult, destination, options.days, outputDir, memory, slug);
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
    destination: string,
    requestedDays: number,
    outputDir: string,
    memory: MemoryStore | null,
    slug: string,
): TripPlannerResult {
    const context = agentResult.context;
    const events = context.events;

    // 1. search_web must have been called.
    const called = toolCallNames(events);
    if (!called.has("search_web")) {
        return fail(
            destination,
            requestedDays,
            outputDir,
            "workflow invariant violated: search_web was never called",
            1,
        );
    }

    // 2. Structured final result required.
    const final = agentResult.finalResult;
    if (final === null) {
        return fail(
            destination,
            requestedDays,
            outputDir,
            agentResult.stoppedByMaxSteps
                ? "agent stopped by maxSteps without producing a trip plan"
                : "agent ended without a structured trip plan",
            1,
        );
    }
    if (final.kind !== "structured") {
        return fail(
            destination,
            requestedDays,
            outputDir,
            `expected structured plan, got ${final.kind}`,
            1,
        );
    }

    // 3. Parse defensively so we own the type.
    const parsed = TripPlanSchema.safeParse(final.output);
    if (!parsed.success) {
        return fail(
            destination,
            requestedDays,
            outputDir,
            `plan does not match expected schema: ${parsed.error.message}`,
            1,
        );
    }
    const plan = parsed.data;

    // 4. Days count must match the request.
    if (plan.days.length !== requestedDays) {
        return fail(
            destination,
            requestedDays,
            outputDir,
            `plan contains ${plan.days.length} days but ${requestedDays} were requested`,
            1,
        );
    }

    // 5. Day numbers must be 1..N in order.
    for (let i = 0; i < plan.days.length; i += 1) {
        const entry = plan.days[i]!;
        const expected = i + 1;
        if (entry.day !== expected) {
            return fail(
                destination,
                requestedDays,
                outputDir,
                `plan.days[${i}].day is ${entry.day}, expected ${expected}`,
                1,
            );
        }
    }

    // 6. Write artifacts atomically. Each file is individually atomic (no
    //    partial content on crash); the pair is not atomic together, but
    //    that is the strongest guarantee a two-file layout can offer
    //    without a manifest.
    const jsonPath = join(outputDir, "plan.json");
    const markdownPath = join(outputDir, "plan.md");
    try {
        writeAtomically(jsonPath, JSON.stringify(plan, null, 2) + "\n");
        writeAtomically(markdownPath, renderMarkdown(plan));
    } catch (error) {
        return fail(
            destination,
            requestedDays,
            outputDir,
            `failed to write artifacts: ${errorMessage(error)}`,
            1,
        );
    }

    // 7. Best-effort memory: store summary keyed by destination slug.
    if (memory !== null) {
        try {
            memory.upsert({
                namespace: "trip-plans",
                key: slug,
                content: plan.summary,
                tags: ["trip-plan"],
            });
        } catch (error) {
            process.stderr.write(
                `[trip-planner] memory store failed (continuing): ${errorMessage(error)}\n`,
            );
        }
    }

    return {
        exitCode: 0,
        destination,
        requestedDays,
        outputDir,
        jsonPath,
        markdownPath,
        plan,
        error: null,
        context,
    };
}

// =========================================================================
// Connection / memory
// =========================================================================

async function openConnection(
    options: TripPlannerOptions,
    workspaceRoot: string,
): Promise<McpConnection> {
    if (options.connectionFactory !== undefined) {
        return options.connectionFactory(workspaceRoot);
    }
    return spawnMcpConnection({ workspaceRoot });
}

function resolveMemoryStore(options: TripPlannerOptions): MemoryStore | null {
    if (options.skipMemory === true) return null;
    if (options.memoryStore !== undefined) return options.memoryStore;
    const path =
        options.memoryPath ||
        process.env.TSAGENT_MEMORY_DB ||
        join(".memory", "memory.sqlite3");
    return new MemoryStore(path);
}

function recallSafely(store: MemoryStore, destination: string): string | null {
    try {
        const rows: MemoryRow[] = store.search(destination, {
            namespace: "trip-plans",
            limit: 1,
        });
        if (rows.length === 0) return null;
        return rows.map((r) => `- ${r.key}: ${r.content}`).join("\n");
    } catch (error) {
        process.stderr.write(
            `[trip-planner] memory recall failed (continuing): ${errorMessage(error)}\n`,
        );
        return null;
    }
}

// =========================================================================
// Prompt
// =========================================================================

function buildInstructions(destination: string, days: number): string {
    return [
        "You are a trip-planning assistant. Produce a structured trip plan.",
        "",
        "You MUST:",
        `1. Call \`search_web\` at least once to gather current information about ${destination}.`,
        `2. Produce a structured plan by calling \`final_answer\`. The \`output\` object MUST have:`,
        `   - \`destination\`: the trip destination (use "${destination}").`,
        "   - `summary`: a one-paragraph overview of the trip.",
        `   - \`days\`: an array of EXACTLY ${days} entries, one per day, numbered 1..${days} in order.`,
        "     Each entry MUST have:",
        `       - \`day\`: the day number (1..${days}, in order).`,
        "       - `title`: a short title for the day.",
        "       - `activities`: a non-empty array of activities. Each activity MUST have:",
        "           - `activity`: description of the activity.",
        "           - `time`: optional time hint (e.g. \"morning\", \"14:00\").",
        "           - `notes`: optional additional notes.",
        "   - `tips`: optional array of practical tips.",
        `3. Do NOT include more or fewer than ${days} days.`,
        "4. Do NOT renumber days out of order.",
    ].join("\n");
}

function composeUserMessage(
    destination: string,
    days: number,
    memoryRecall: string | null,
): string {
    const lines: string[] = [];
    if (memoryRecall !== null) {
        lines.push("Prior trip plan for this destination (may be stale; cross-check):");
        lines.push(memoryRecall);
        lines.push("");
    }
    lines.push(`Destination: ${destination}`);
    lines.push(`Days: ${days}`);
    lines.push("");
    lines.push(
        "Research the destination, then emit the plan via `final_answer`.",
    );
    return lines.join("\n");
}

// =========================================================================
// Markdown rendering
// =========================================================================

function renderMarkdown(plan: TripPlan): string {
    const lines: string[] = [];
    lines.push(`# ${plan.destination} — ${plan.days.length}-Day Plan`);
    lines.push("");
    lines.push(plan.summary);
    lines.push("");

    for (const day of plan.days) {
        lines.push(`## Day ${day.day}: ${day.title}`);
        lines.push("");
        for (const activity of day.activities) {
            if (activity.time !== null && activity.time !== "") {
                lines.push(`- **${activity.time}** — ${activity.activity}`);
            } else {
                lines.push(`- ${activity.activity}`);
            }
            if (activity.notes !== null && activity.notes !== "") {
                lines.push(`  ${activity.notes}`);
            }
        }
        lines.push("");
    }

    if (plan.tips.length > 0) {
        lines.push("## Tips");
        lines.push("");
        for (const tip of plan.tips) {
            lines.push(`- ${tip}`);
        }
        lines.push("");
    }

    return lines.join("\n");
}

// =========================================================================
// Failure helper
// =========================================================================

function fail(
    destination: string,
    requestedDays: number,
    outputDir: string,
    message: string,
    exitCode: 1 | 2 | 3,
): TripPlannerResult {
    return {
        exitCode,
        destination,
        requestedDays,
        outputDir,
        jsonPath: null,
        markdownPath: null,
        plan: null,
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
        .name("tsagent-trip-planner")
        .description("Plan a multi-day trip and produce structured artifacts.")
        .argument("<destination>", "trip destination")
        .requiredOption(
            "--days <n>",
            `number of days (1..${MAX_DAYS})`,
            (v) => parseInt(v, 10),
        )
        .option("--output-dir <path>", "output directory")
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

    const destination = program.args[0] as string;
    const opts = program.opts<{
        days: number;
        outputDir?: string;
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
            "[trip-planner] --approve and --deny are mutually exclusive\n",
        );
        return 2;
    }

    let confirmToolCall:
        | ((toolCall: ToolCall, tool: BaseTool) => boolean | Promise<boolean>)
        | undefined;
    if (opts.approve === true) confirmToolCall = () => true;
    else if (opts.deny === true) confirmToolCall = () => false;

    const result = await runTripPlanner({
        destination,
        days: opts.days,
        ...(opts.outputDir !== undefined ? { outputDir: opts.outputDir } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        ...(opts.memoryDb !== undefined ? { memoryPath: opts.memoryDb } : {}),
        ...(opts.skipMemory === true ? { skipMemory: true } : {}),
        ...(opts.allowDangerous === true ? { allowDangerous: true } : {}),
        ...(opts.keepOnFailure === true ? { keepOnFailure: true } : {}),
        ...(confirmToolCall !== undefined ? { confirmToolCall } : {}),
    });

    if (result.error !== null) {
        process.stderr.write(`[trip-planner] ${result.error}\n`);
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
            process.stderr.write(`[trip-planner] fatal: ${errorMessage(error)}\n`);
            process.exit(1);
        },
    );
}