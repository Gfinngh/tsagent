#!/usr/bin/env node
/**
 * tsagent CLI.
 *
 * Exit codes:
 *   0  success (completed run, or no-op resume)
 *   1  LLM or MCP failure
 *   2  usage error (bad flags, missing args)
 *   3  quota exhausted
 *   130 interrupted by SIGINT (after graceful cleanup)
 */

import { Command, CommanderError } from "commander";
import { config as loadEnv } from "dotenv";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
    Agent,
    AgentTimeoutError,
    CancelledError,
    LlmCallError,
    detectResumeState,
} from "./src/agent/agent.js";
import { McpConnection, loadMcpTools } from "./src/agent/client.js";
import { ExecutionContext, type FinalResult } from "./src/agent/context.js";
import { JsonlEventLog } from "./src/agent/event-log.js";
import type { LlmUsage } from "./src/agent/llm.js";
import {
    buildDefaultFallbackChain,
    spawnMcpConnection,
} from "./src/agent/runtime.js";
import { initTracing, shutdownTracing } from "./src/agent/tracing.js";
import type { ToolCall } from "./src/agent/schemas.js";
import type { BaseTool } from "./src/agent/tools/base.js";

loadEnv();

const MCP_CONNECT_TIMEOUT_MS = 10_000;

interface CliOptions {
    log?: string;
    resume?: boolean;
    approve?: boolean;
    deny?: boolean;
    allowDangerous?: boolean;
    model?: string;
    tracing?: boolean;
    maxSteps?: number;
}

// =========================================================================
// Entry point
// =========================================================================

async function main(): Promise<number> {
    const program = new Command();
    program
        .name("tsagent")
        .description("Run a ReAct agent with MCP tools.")
        .argument("[prompt]", "user message")
        .option(
            "--log <path>",
            "path to write (fresh) or read (resume) the JSONL event log",
        )
        .option("--resume", "resume from --log")
        .option("--approve", "auto-approve all confirmations")
        .option("--deny", "auto-deny all confirmations")
        .option("--allow-dangerous", "allow dangerous tools")
        .option("--model <name>", "primary model")
        .option("--no-tracing", "disable tracing")
        .option("--max-steps <n>", "max agent steps", (v) => parseInt(v, 10))
        .exitOverride();

    try {
        program.parse(process.argv);
    } catch (error) {
        if (error instanceof CommanderError) {
            return error.exitCode === 0 ? 0 : 2;
        }
        throw error;
    }

    const options = program.opts<CliOptions>();
    const prompt = program.args[0] as string | undefined;

    if (options.approve === true && options.deny === true) {
        process.stderr.write(
            "[tsagent] --approve and --deny are mutually exclusive\n",
        );
        return 2;
    }

    if (options.tracing !== false) initTracing();

    // Top-level abort controller. SIGINT aborts this; the run path
    // observes the signal, unwinds through its `finally` blocks (closing
    // the log, closing the MCP connection, flushing traces), and returns
    // 130. This is what makes SIGINT safe: without it, `process.exit(130)`
    // in a signal handler skips all cleanup and orphans the MCP child.
    const controller = new AbortController();
    installSignalHandlers(controller);

    try {
        checkInteractiveMode(options);

        let code: number;
        if (options.resume === true) {
            code = await runResume(prompt, options, controller.signal);
        } else {
            if (prompt === undefined) {
                process.stderr.write("[tsagent] missing prompt (or use --resume)\n");
                return 2;
            }
            code = await runFresh(prompt, options, controller.signal);
        }

        // If SIGINT fired at any point, the exit code is 130 regardless of
        // what the inner function returned. Cancellation wins.
        if (controller.signal.aborted) return 130;
        return code;
    } finally {
        await shutdownTracing();
    }
}

// =========================================================================
// Fresh run
// =========================================================================

async function runFresh(
    prompt: string,
    options: CliOptions,
    signal: AbortSignal,
): Promise<number> {
    const logPath = resolveFreshLogPath(options.log);
    if (existsSync(logPath)) {
        try {
            rmSync(logPath);
        } catch (error) {
            process.stderr.write(
                `[tsagent] cannot delete existing log ${logPath}: ${(error as Error).message}\n`,
            );
            return 1;
        }
    }

    let connection: McpConnection;
    try {
        connection = await spawnMcpFromCli();
    } catch (error) {
        if (signal.aborted) return 130;
        printMcpSpawnFailure(error);
        return 1;
    }

    // If SIGINT fired before the agent even started, close the connection
    // and short-circuit.
    if (signal.aborted) {
        await connection.close();
        return 130;
    }

    try {
        const tools = await loadMcpTools(connection);
        const agent = buildAgent(options, tools);

        // fsync: true — this log feeds `--resume`, so it must survive a
        // crash or power loss, not just a normal process exit.
        const log = new JsonlEventLog(logPath, { fsync: true });
        try {
            const result = await agent.run(prompt, {
                signal,
                onEvent: (event) => log.append(event),
            });
            printResult(result.finalResult, result.usage, result.stoppedByMaxSteps);
            return result.finalResult !== null ? 0 : 1;
        } catch (error) {
            return handleRunError(error);
        } finally {
            log.close();
        }
    } finally {
        await connection.close();
    }
}

// =========================================================================
// Resume
// =========================================================================

async function runResume(
    prompt: string | undefined,
    options: CliOptions,
    signal: AbortSignal,
): Promise<number> {
    if (options.log === undefined || options.log === "") {
        process.stderr.write("[tsagent] --resume requires --log <source>\n");
        return 2;
    }
    const sourcePath = resolve(options.log);
    if (!existsSync(sourcePath)) {
        process.stderr.write(`[tsagent] source log not found: ${sourcePath}\n`);
        return 2;
    }

    let context: ExecutionContext;
    try {
        context = ExecutionContext.fromLog(sourcePath);
    } catch (error) {
        process.stderr.write(
            `[tsagent] failed to read source log: ${(error as Error).message}\n`,
        );
        return 2;
    }

    const state = detectResumeState(context);
    if (state === "complete" && prompt === undefined) {
        process.stderr.write(
            "[tsagent] run is already complete (no new log written)\n",
        );
        return 0;
    }

    const destPath = resolveResumeLogPath();
    if (resolve(destPath) === sourcePath) {
        process.stderr.write(
            "[tsagent] --resume cannot write onto the source log\n",
        );
        return 2;
    }
    if (existsSync(destPath)) {
        try {
            rmSync(destPath);
        } catch (error) {
            process.stderr.write(
                `[tsagent] cannot delete existing log ${destPath}: ${(error as Error).message}\n`,
            );
            return 1;
        }
    }

    let connection: McpConnection;
    try {
        connection = await spawnMcpFromCli();
    } catch (error) {
        if (signal.aborted) return 130;
        printMcpSpawnFailure(error);
        return 1;
    }

    if (signal.aborted) {
        await connection.close();
        return 130;
    }

    try {
        const tools = await loadMcpTools(connection);
        const agent = buildAgent(options, tools);

        // fsync: true — the resume log can itself be resumed later, so the
        // same durability guarantee applies.
        const log = new JsonlEventLog(destPath, { fsync: true });
        try {
            // Seed the destination log with the rehydrated events.
            const seedCount = context.events.length;
            for (let i = 0; i < seedCount; i += 1) log.append(context.events[i]!);

            const result = await agent.resume(context, {
                signal,
                ...(prompt !== undefined ? { userMessage: prompt } : {}),
                onEvent: (event) => log.append(event),
            });

            printResult(result.finalResult, result.usage, result.stoppedByMaxSteps);
            return result.finalResult !== null ? 0 : 1;
        } catch (error) {
            return handleRunError(error);
        } finally {
            log.close();
        }
    } finally {
        await connection.close();
    }
}

// =========================================================================
// Shared agent construction
// =========================================================================

function buildAgent(options: CliOptions, tools: BaseTool[]): Agent {
    const llm = buildDefaultFallbackChain(options.model);
    return new Agent({
        llmClient: llm,
        tools,
        confirmToolCall: makeConfirmToolCall(options),
        allowDangerous: options.allowDangerous === true,
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    });
}

// =========================================================================
// MCP
// =========================================================================

function spawnMcpFromCli(): Promise<McpConnection> {
    return spawnMcpConnection({
        workspaceRoot: process.env.WORKSPACE_ROOT ?? process.cwd(),
        connectTimeoutMs: MCP_CONNECT_TIMEOUT_MS,
    });
}

function printMcpSpawnFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[tsagent] MCP server failed to start: ${message}\n`);
}

// =========================================================================
// Log path resolution
// =========================================================================

function resolveFreshLogPath(explicit: string | undefined): string {
    if (explicit !== undefined && explicit !== "") return resolve(explicit);
    const envPath = process.env.TSAGENT_LOG_PATH;
    if (envPath !== undefined && envPath !== "") return resolve(envPath);
    return resolve("runs", `host-${timestamp()}.jsonl`);
}

function resolveResumeLogPath(): string {
    const envPath = process.env.TSAGENT_LOG_PATH;
    if (envPath !== undefined && envPath !== "") return resolve(envPath);
    return resolve("runs", `host-${timestamp()}-resume.jsonl`);
}

function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

// =========================================================================
// Approvals
// =========================================================================

function checkInteractiveMode(options: CliOptions): void {
    if (options.approve === true || options.deny === true) return;
    if (process.stdin.isTTY === true) return;
    process.stderr.write(
        "[tsagent] stdin is not a TTY. Interactive confirmations will default to deny. " +
        "Use --approve or --deny to override.\n",
    );
}

/**
 * Strip control characters from text that will be written to a
 * terminal. Prevents ANSI escape sequences in tool arguments from
 * injecting terminal control codes into the confirm prompt.
 */
function sanitizeForTerminal(text: string): string {
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function makeConfirmToolCall(
    options: CliOptions,
): (toolCall: ToolCall, tool: BaseTool) => Promise<boolean> {
    if (options.approve === true) return async () => true;
    if (options.deny === true) return async () => false;
    if (process.stdin.isTTY !== true) return async () => false;

    return async (toolCall, tool) => {
        const rawArgs = JSON.stringify(toolCall.arguments);
        const args = sanitizeForTerminal(rawArgs);
        const name = sanitizeForTerminal(tool.name);
        process.stderr.write(`\n[confirm] ${name}(${args}) — approve? [y/N] `);
        const line = await readLine();
        return /^y(es)?$/i.test(line.trim());
    };
}

function readLine(): Promise<string> {
    return new Promise((resolve) => {
        let buffered = "";
        const onData = (chunk: Buffer) => {
            buffered += chunk.toString();
            const idx = buffered.indexOf("\n");
            if (idx >= 0) {
                process.stdin.removeListener("data", onData);
                process.stdin.pause();
                resolve(buffered.slice(0, idx));
            }
        };
        process.stdin.on("data", onData);
        process.stdin.resume();
    });
}

// =========================================================================
// Output + error handling
// =========================================================================

function printResult(
    final: FinalResult | null,
    usage: LlmUsage | null,
    stoppedByMaxSteps: boolean,
): void {
    if (final === null) {
        process.stderr.write(
            stoppedByMaxSteps
                ? "[tsagent] stopped: max steps reached without a final answer\n"
                : "[tsagent] stopped: no final answer\n",
        );
    } else if (final.kind === "text") {
        process.stdout.write(final.text + "\n");
    } else {
        process.stdout.write(JSON.stringify(final.output, null, 2) + "\n");
    }

    if (usage !== null) {
        process.stderr.write(
            `[tsagent] tokens: prompt=${usage.promptTokens} completion=${usage.completionTokens} total=${usage.totalTokens}\n`,
        );
    }
}

function handleRunError(error: unknown): number {
    if (error instanceof LlmCallError) {
        process.stderr.write(`[tsagent] LLM error: ${error.message}\n`);
        if (error.metadata.quotaExhausted === true) {
            process.stderr.write("[tsagent] quota exhausted\n");
            return 3;
        }
        return 1;
    }
    if (error instanceof AgentTimeoutError) {
        process.stderr.write(`[tsagent] timeout: ${error.message}\n`);
        return 1;
    }
    if (error instanceof CancelledError) {
        // CancelledError is thrown only when the caller-supplied signal
        // aborts (SIGINT in the CLI). Exit 130 is the conventional
        // "interrupted by SIGINT" code.
        process.stderr.write("[tsagent] cancelled\n");
        return 130;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[tsagent] error: ${message}\n`);
    return 1;
}

/**
 * Install the SIGINT handler. First SIGINT triggers a graceful abort
 * (which flushes through the run path's `finally` blocks). Second SIGINT
 * force-exits — for the case where cleanup itself hangs.
 */
function installSignalHandlers(controller: AbortController): void {
    let count = 0;
    process.on("SIGINT", () => {
        count += 1;
        if (count === 1) {
            process.stderr.write(
                "\n[tsagent] interrupted — cleaning up (press Ctrl+C again to force exit)\n",
            );
            controller.abort(new Error("SIGINT"));
        } else {
            process.stderr.write("\n[tsagent] forced exit\n");
            process.exit(130);
        }
    });
}

// =========================================================================
// Bootstrap
// =========================================================================

main().then(
    (code) => process.exit(code),
    (error) => {
        process.stderr.write(
            `[tsagent] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
    },
);