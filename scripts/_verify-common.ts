/**
 * Shared helpers for verification scripts.
 *
 * Output conventions (matching production code in `src/`):
 * - Progress lines and OK checks → `process.stdout.write`
 * - SKIP lines                    → `process.stderr.write`
 * - Failure lines                 → `process.stderr.write`
 * - Summary                       → `process.stdout.write`
 *
 * No `console.*` anywhere in this module or in any verification
 * script. Console forwarding is Node-version-dependent and makes
 * stream-capture fragile if a verify script ever becomes a subprocess
 * of another. Direct writes are the same API production code uses, so
 * the invariant "stdout = human data, stderr = diagnostics" holds
 * uniformly across the project.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let checks = 0;
let failures = 0;
let skips = 0;

export class AssertionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AssertionError";
    }
}

/** Write to stdout with a trailing newline. */
function out(line: string): void {
    process.stdout.write(line + "\n");
}

/** Write to stderr with a trailing newline. */
function err(line: string): void {
    process.stderr.write(line + "\n");
}

/** Hard check: prints and throws `AssertionError` on failure. */
export function check(condition: unknown, message: string): asserts condition {
    checks += 1;
    if (!condition) {
        failures += 1;
        err(`✗ ${message}`);
        throw new AssertionError(message);
    }
    out(`✓ ${message}`);
}

/** Hard equality check with a readable diff on failure. */
export function checkEqual<T>(actual: T, expected: T, message: string): void {
    checks += 1;
    if (deepEqual(actual, expected)) {
        out(`✓ ${message}`);
        return;
    }
    failures += 1;
    err(`✗ ${message}`);
    err(`  expected: ${safeStringify(expected)}`);
    err(`  actual:   ${safeStringify(actual)}`);
    throw new AssertionError(message);
}

/** Soft check: records a failure but does not throw (for bulk assertions). */
export function checkSoft(condition: unknown, message: string): boolean {
    checks += 1;
    if (!condition) {
        failures += 1;
        err(`✗ ${message}`);
        return false;
    }
    out(`✓ ${message}`);
    return true;
}

export function skip(message: string): void {
    skips += 1;
    err(`SKIP ${message}`);
}

export interface TempDir {
    path: string;
    cleanup(): void;
}

export function makeTempDir(prefix: string): TempDir {
    const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
    return {
        path,
        cleanup(): void {
            rmSync(path, { recursive: true, force: true });
        },
    };
}

/**
 * Run a verification script body. Prints a summary line and sets
 * `process.exitCode` in `finally` so cleanup in the caller always runs
 * before the process exits.
 */
export function runScript(body: () => void | Promise<void>): void {
    void (async () => {
        try {
            await body();
        } catch (error) {
            if (error instanceof AssertionError) {
                err(`\n✗ FAILED: ${error.message}`);
            } else {
                failures += 1;
                err(
                    `\n✗ FAILED: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        } finally {
            printSummary();
        }
    })();
}

function printSummary(): void {
    const c = pluralize(checks, "check");
    const f = pluralize(failures, "failure");
    const s = pluralize(skips, "skip");
    out(`\n${c}, ${f}, ${s}`);
    if (failures > 0) process.exitCode = 1;
}

function pluralize(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    if (a === null || b === null) return false;

    const aIsArray = Array.isArray(a);
    const bIsArray = Array.isArray(b);
    if (aIsArray !== bIsArray) return false;

    if (aIsArray && bIsArray) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i += 1) {
            if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
    }

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
        if (!(key in bObj)) return false;
        if (!deepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
}