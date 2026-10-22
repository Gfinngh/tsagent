#!/usr/bin/env node
/**
 * Probe each model in the current fallback chain with a minimal one-shot
 * prompt and report availability with the current API key.
 *
 * The chain order follows `TSAGENT_MODEL_ORDER` (default: `test` =
 * weakest first). Probes are run serially in chain order so quota burn
 * stops at the first working model if you Ctrl+C.
 *
 * Exit codes:
 *   0  at least one model responded successfully
 *   1  every model failed
 *   2  no API key set (and no injected factory)
 */

import { Command, CommanderError } from "commander";
import { config as loadEnv } from "dotenv";
import type {
    LlmClientProtocol,
    LlmErrorMetadata,
    LlmRequest,
    LlmResponse,
} from "./src/agent/llm.js";
import { LlmClient } from "./src/agent/llm.js";
import { getModelChain, resolveModel } from "./src/agent/models.js";
import { GoogleTransport } from "./src/agent/transport/google.js";
import {
    makeEvent,
    messageContentItem,
} from "./src/agent/schemas.js";

const PROBE_PROMPT = "Reply with the single word: ok";
const DEFAULT_TIMEOUT_MS = 30_000;

// =========================================================================
// Public types
// =========================================================================

export interface ProbeResult {
    model: string;
    ok: boolean;
    elapsedMs: number;
    detail: string;
    metadata: LlmErrorMetadata;
}

export interface ProbeModelsOptions {
    models?: string[];
    apiKey?: string;
    clientFactory?: (model: string) => LlmClientProtocol;
    timeoutMs?: number;
}

export interface ProbeModelsSummary {
    exitCode: 0 | 1 | 2;
    error: string | null;
    results: ProbeResult[];
    okCount: number;
    failCount: number;
}

// =========================================================================
// Orchestration
// =========================================================================

export async function runProbeModels(
    options: ProbeModelsOptions = {},
): Promise<ProbeModelsSummary> {
    const models = options.models ?? getModelChain();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let factory = options.clientFactory;
    if (factory === undefined) {
        const apiKey =
            options.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
        if (apiKey === undefined || apiKey === "") {
            return {
                exitCode: 2,
                error: "no GEMINI_API_KEY or GOOGLE_API_KEY set",
                results: [],
                okCount: 0,
                failCount: 0,
            };
        }
        factory = (model) => {
            let resolved: string;
            try {
                resolved = resolveModel(model);
            } catch (error) {
                // Surface the misconfiguration as a probe failure, not a crash.
                return {
                    async generate(): Promise<LlmResponse> {
                        return {
                            text: null,
                            toolCalls: [],
                            usage: null,
                            providerOptions: {},
                            errorMessage: error instanceof Error ? error.message : String(error),
                            errorMetadata: { errorType: "bad_request" },
                        };
                    },
                };
            }
            const transport = new GoogleTransport(resolved, { apiKey });
            return new LlmClient({
                model: resolved,
                transport,
                maxRetries: 0,
                timeoutMs,
            });
        };
    }

    const results: ProbeResult[] = [];
    for (const model of models) {
        results.push(await probeOne(model, factory));
    }
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    return {
        exitCode: okCount > 0 ? 0 : 1,
        error: null,
        results,
        okCount,
        failCount,
    };
}

async function probeOne(
    model: string,
    factory: (model: string) => LlmClientProtocol,
): Promise<ProbeResult> {
    const start = Date.now();
    try {
        const client = factory(model);
        const request: LlmRequest = {
            instructions: [],
            events: [
                makeEvent([messageContentItem({ role: "user", content: PROBE_PROMPT })]),
            ],
        };
        const response: LlmResponse = await client.generate(request);
        const elapsedMs = Date.now() - start;
        if (response.errorMessage !== null) {
            return {
                model,
                ok: false,
                elapsedMs,
                detail: truncate(response.errorMessage, 60),
                metadata: response.errorMetadata,
            };
        }
        return {
            model,
            ok: true,
            elapsedMs,
            detail: truncate((response.text ?? "").trim(), 60),
            metadata: response.errorMetadata,
        };
    } catch (error) {
        return {
            model,
            ok: false,
            elapsedMs: Date.now() - start,
            detail: truncate(error instanceof Error ? error.message : String(error), 60),
            metadata: {},
        };
    }
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function formatResult(r: ProbeResult): string {
    const mark = r.ok ? "✓" : "✗";
    const name = r.model.padEnd(34);
    const time = `${(r.elapsedMs / 1000).toFixed(1)}s`.padStart(6);
    const detail = r.detail.length > 0 ? `  ${r.detail}` : "";
    return `  ${mark} ${name}${time}${detail}`;
}

// =========================================================================
// CLI entry
// =========================================================================

async function cliMain(): Promise<number> {
    loadEnv();

    const program = new Command();
    program
        .name("tsagent-probe-models")
        .description(
            "Probe each model in the fallback chain with a one-shot prompt.",
        )
        .option(
            "--model <name>",
            "model to probe (repeatable; default: current chain)",
            (v, prev: string[] = []) => [...prev, v],
        )
        .option("--timeout-ms <n>", "per-probe timeout", (v) => parseInt(v, 10))
        .exitOverride();

    try {
        program.parse(process.argv);
    } catch (error) {
        if (error instanceof CommanderError) {
            return error.exitCode === 0 ? 0 : 2;
        }
        throw error;
    }

    const opts = program.opts<{ model?: string[]; timeoutMs?: number }>();
    const models =
        opts.model !== undefined && opts.model.length > 0 ? opts.model : undefined;

    const summary = await runProbeModels({
        ...(models !== undefined ? { models } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });

    if (summary.error !== null) {
        process.stderr.write(`[probe-models] ${summary.error}\n`);
        return summary.exitCode;
    }

    process.stdout.write(
        `Probing ${summary.results.length} model(s) with current API key...\n\n`,
    );
    for (const r of summary.results) {
        process.stdout.write(`${formatResult(r)}\n`);
    }
    process.stdout.write(
        `\n${summary.okCount} of ${summary.results.length} models available.\n`,
    );
    return summary.exitCode;
}

const invokedDirectly =
    typeof process.argv[1] === "string" &&
    import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
    cliMain().then(
        (code) => process.exit(code),
        (error) => {
            process.stderr.write(
                `[probe-models] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exit(1);
        },
    );
}