/**
 * Workflow-specific shared helpers.
 *
 * The MCP-spawn, LLM-chain, and default-confirm primitives are
 * runtime concerns and live in `src/agent/runtime.ts`. They are
 * re-exported here so workflow imports stay stable; new callers that
 * are not workflows (like `main.ts`) should import directly from
 * `src/agent/runtime.ts`.
 */

import { randomBytes } from "node:crypto";
import {
    closeSync,
    existsSync,
    fsyncSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExecutionContext } from "../agent/context.js";
import type { AgentEvent } from "../agent/schemas.js";

// Re-export the runtime primitives that workflows consume.
export {
    spawnMcpConnection,
    buildDefaultFallbackChain,
    defaultWorkflowConfirm,
} from "../agent/runtime.js";

// =========================================================================
// Atomic file writes
// =========================================================================

/**
 * Write `content` to `path` atomically: the file either retains its
 * previous content (failure) or has the new content (success). Never a
 * partially-written file.
 *
 * Mechanism: write to a uniquely-named `.tmp` sibling, `fsync` it to
 * disk, then `rename` over the target. `rename` is atomic on POSIX, so
 * any reader either sees the old inode or the new one, never a mix.
 *
 * The parent directory must exist. Callers that may be creating it
 * fresh should `mkdirSync(dirname(path), { recursive: true })` first —
 * `writeAtomically` does not.
 *
 * Not atomic across *multiple* files (two `renameSync` calls are not
 * one operation). For multi-file writes, each file is independently
 * atomic; a failure between renames leaves one artifact written and
 * one not. Callers that need stronger guarantees should write a
 * manifest and treat the manifest as the commit point.
 */
export function writeAtomically(path: string, content: string): void {
    const dir = dirname(path);
    const tmpName = `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`;
    const tmpPath = join(dir, tmpName);

    let fd: number | null = null;
    try {
        fd = openSync(tmpPath, "wx");
        // writeSync may perform a partial write; loop until all bytes land.
        const buf = Buffer.from(content, "utf8");
        let offset = 0;
        while (offset < buf.length) {
            offset += writeSync(fd, buf, offset);
        }
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        renameSync(tmpPath, path);
    } catch (error) {
        if (fd !== null) {
            try {
                closeSync(fd);
            } catch {
                // ignore
            }
        }
        try {
            unlinkSync(tmpPath);
        } catch {
            // temp file may not exist — that's fine
        }
        throw error;
    }
}

// =========================================================================
// Slug + timestamp
// =========================================================================

export function slugify(text: string, maxLength = 64): string {
    const slug = text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, maxLength);
    return slug.length > 0 ? slug : "brief";
}

export function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

// =========================================================================
// Brief instructions
// =========================================================================

export const BRIEF_SECTIONS = [
    "## Summary",
    "## Key Facts",
    "## Sources",
    "## Open Questions",
] as const;

const BRIEF_SECTION_LIST = [
    "     ## Summary",
    "     (one paragraph)",
    "     ## Key Facts",
    "     (bullet points)",
    "     ## Sources",
    "     (bullet points with title and URL)",
    "     ## Open Questions",
    "     (bullet points)",
].join("\n");

export const FRESH_BRIEF_INSTRUCTIONS = [
    "You are a research assistant. Produce a structured research brief.",
    "",
    "You MUST:",
    "1. Call `search_web` at least once to gather sources on the topic.",
    "2. Call `write_file` exactly once with `path: \"brief.md\"` and the brief content.",
    "   The markdown MUST contain exactly these top-level sections, in this order:",
    BRIEF_SECTION_LIST,
    "3. Do not write to any other path. Do not skip any section.",
    "4. After writing the file, respond with a one-line confirmation.",
].join("\n");

export function refineBriefInstructions(refinement: string): string {
    return [
        "You are updating a research brief based on a refinement request.",
        "",
        "Context:",
        "- The prior conversation in your history contains the previous version of the brief.",
        "- You are now in a NEW workspace (empty).",
        "- The prior brief.md is NOT available in this workspace.",
        "",
        "You MUST:",
        "1. Call `search_web` at least once to refresh or gather additional sources.",
        "2. Call `write_file` exactly once with `path: \"brief.md\"` and the updated brief.",
        "   The markdown MUST contain exactly these top-level sections, in this order:",
        BRIEF_SECTION_LIST,
        "3. Do not write to any other path. Do not skip any section.",
        "4. After writing the file, respond with a one-line confirmation.",
        "",
        "Refinement request:",
        refinement,
    ].join("\n");
}

// =========================================================================
// Brief validation
// =========================================================================

export interface BriefValidation {
    valid: true;
    briefPath: string;
    content: string;
    summary: string | null;
}

export interface BriefValidationError {
    valid: false;
    reason: string;
}

export function validateBriefOutcome(
    context: ExecutionContext,
    outputDir: string,
    options: { sinceEventIndex?: number } = {},
): BriefValidation | BriefValidationError {
    const sinceIndex = options.sinceEventIndex ?? 0;

    if (!toolWasCalled(context, "search_web", sinceIndex)) {
        return {
            valid: false,
            reason: "workflow invariant violated: search_web was never called",
        };
    }
    if (!toolWasCalled(context, "write_file", sinceIndex)) {
        return {
            valid: false,
            reason: "workflow invariant violated: write_file was never called",
        };
    }

    const briefPath = join(outputDir, "brief.md");
    if (!existsSync(briefPath)) {
        return {
            valid: false,
            reason: "brief was not written to the expected path (brief.md)",
        };
    }

    let content: string;
    try {
        content = readFileSync(briefPath, "utf8");
    } catch (error) {
        return {
            valid: false,
            reason: `failed to read brief: ${errorMessage(error)}`,
        };
    }

    for (const section of BRIEF_SECTIONS) {
        if (!containsSection(content, section)) {
            return {
                valid: false,
                reason: `brief is missing required section: ${section}`,
            };
        }
    }

    const summary = extractSection(content, "## Summary");
    return { valid: true, briefPath, content, summary };
}

function toolWasCalled(
    context: ExecutionContext,
    toolName: string,
    sinceIndex: number,
): boolean {
    for (let i = sinceIndex; i < context.events.length; i += 1) {
        const event = context.events[i];
        if (event === undefined) continue;
        for (const item of event.content) {
            if (item.type === "tool_call" && item.toolCall.name === toolName) {
                return true;
            }
        }
    }
    return false;
}

function containsSection(content: string, heading: string): boolean {
    return new RegExp(`^${escapeRegex(heading)}\\s*$`, "m").test(content);
}

function extractSection(content: string, heading: string): string | null {
    const headingRegex = new RegExp(`^${escapeRegex(heading)}\\s*$`, "m");
    const match = headingRegex.exec(content);
    if (match === null) return null;
    const afterHeading = content.slice(match.index + match[0].length);
    const nextHeadingMatch = /^## /m.exec(afterHeading);
    const section =
        nextHeadingMatch === null
            ? afterHeading
            : afterHeading.slice(0, nextHeadingMatch.index);
    const trimmed = section.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// =========================================================================
// Event scanning helpers
// =========================================================================

export function toolCallNames(events: AgentEvent[]): Set<string> {
    const names = new Set<string>();
    for (const event of events) {
        for (const item of event.content) {
            if (item.type === "tool_call") names.add(item.toolCall.name);
        }
    }
    return names;
}

export function toolCallPaths(
    events: AgentEvent[],
    toolName: string,
): Set<string> {
    const paths = new Set<string>();
    for (const event of events) {
        for (const item of event.content) {
            if (item.type !== "tool_call") continue;
            if (item.toolCall.name !== toolName) continue;
            const arg = item.toolCall.arguments.path;
            if (typeof arg === "string" && arg.length > 0) paths.add(arg);
        }
    }
    return paths;
}

// =========================================================================
// Version discovery
// =========================================================================

export function listVersions(baseDir: string): number[] {
    if (!existsSync(baseDir)) return [];
    let entries;
    try {
        entries = readdirSync(baseDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
        return [];
    }
    const versions: number[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const match = entry.name.match(/^v(\d+)$/);
        if (match === null) continue;
        const n = parseInt(match[1]!, 10);
        if (Number.isFinite(n) && n > 0) versions.push(n);
    }
    versions.sort((a, b) => a - b);
    return versions;
}

// =========================================================================
// Error helpers
// =========================================================================

export function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

export function exitCodeFor(error: unknown): 1 | 3 {
    if (
        error !== null &&
        typeof error === "object" &&
        "metadata" in error &&
        typeof (error as { metadata?: unknown }).metadata === "object" &&
        (error as { metadata: { quotaExhausted?: boolean } }).metadata
            .quotaExhausted === true
    ) {
        return 3;
    }
    return 1;
}