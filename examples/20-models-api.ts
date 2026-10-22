/**
 * 20 — Model chain and provider-prefix resolution
 *
 * The model chain is a fixed list, ordered strongest-first in `prod`
 * order or weakest-first in `test` order. Both orders are controlled
 * by the `TSAGENT_MODEL_ORDER` env var. Model IDs may carry a
 * provider prefix like `gemini/...` (copied from the Python source);
 * `resolveModel()` strips it before the AI SDK sees it.
 *
 * This example prints the chain under different `TSAGENT_MODEL_ORDER`
 * values and demonstrates `resolveModel()` behavior.
 *
 *   npx tsx examples/20-models-api.ts
 */

import {
    getModelChain,
    getModelOrder,
    resolveModel,
} from "../src/agent/models.js";
import { section } from "./_common.js";

function withEnv<T>(value: string | undefined, fn: () => T): T {
    const prev = process.env.TSAGENT_MODEL_ORDER;
    if (value === undefined) {
        delete process.env.TSAGENT_MODEL_ORDER;
    } else {
        process.env.TSAGENT_MODEL_ORDER = value;
    }
    try {
        return fn();
    } finally {
        if (prev === undefined) {
            delete process.env.TSAGENT_MODEL_ORDER;
        } else {
            process.env.TSAGENT_MODEL_ORDER = prev;
        }
    }
}

function main(): void {
    section('1. default order (TSAGENT_MODEL_ORDER unset → "test")');
    withEnv(undefined, () => {
        console.log(`  order: ${getModelOrder()}`);
        const chain = getModelChain();
        for (let i = 0; i < chain.length; i += 1) {
            console.log(`  [${i}] ${chain[i]}`);
        }
        console.log("  (weakest → strongest, quota-frugal for testing)");
    });

    section('2. prod order (TSAGENT_MODEL_ORDER="prod")');
    withEnv("prod", () => {
        console.log(`  order: ${getModelOrder()}`);
        const chain = getModelChain();
        for (let i = 0; i < chain.length; i += 1) {
            console.log(`  [${i}] ${chain[i]}`);
        }
        console.log("  (strongest → weakest, best quality first)");
    });

    section('3. unrecognized value falls back to "test"');
    withEnv("something-weird", () => {
        console.log(`  order: ${getModelOrder()}`);
    });

    section("4. resolveModel — strip the provider prefix");
    const cases = [
        "gemini/gemini-3.8-flash",
        "google/gemini-3.8-flash",
        "gemini-3.8-flash",
        "openai/gpt-4",
        "",
    ];
    for (const input of cases) {
        try {
            const out = resolveModel(input);
            console.log(`  ${JSON.stringify(input).padEnd(28)} → ${out}`);
        } catch (error) {
            console.log(
                `  ${JSON.stringify(input).padEnd(28)} → rejected: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    section("notes");
    console.log(
        "The chain order is used by buildDefaultFallbackChain() (src/agent/runtime.ts).",
    );
    console.log(
        "FallbackClient tries entry 0 first, then entry 1 on retryable failures, etc.",
    );
    console.log(
        "Set TSAGENT_MODEL_ORDER=prod in .env to prefer the strongest models first.",
    );
}

main();