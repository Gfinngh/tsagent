import Database from "better-sqlite3";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { BaseTool, FunctionTool } from "./tools/base.js";

// =========================================================================
// Bounds
// =========================================================================

/**
 * Hard caps applied to every memory write — both at the tool boundary
 * (via zod `.max()`) and inside `MemoryStore.upsert` (as a defense in
 * depth for direct API callers). Kept in one place so tool schemas and
 * the store cannot drift.
 *
 * Values chosen so that a hostile or runaway model cannot:
 *   - blow up the FTS index with a single gigantic entry
 *   - make every subsequent query slow by writing a many-MB blob
 *   - spam unbounded tag lists that multiply per-row cost
 *
 * They are generous for legitimate use: 64 KiB of content is ~10,000
 * words of text, 256 chars for a key is more than any human-readable
 * identifier needs, 128 chars for a namespace covers dotted hierarchy
 * paths.
 */
const MAX_KEY_LENGTH = 256;
const MAX_CONTENT_LENGTH = 64 * 1024;
const MAX_NAMESPACE_LENGTH = 128;
const MAX_TAG_LENGTH = 64;
const MAX_TAGS = 32;
const MAX_QUERY_LENGTH = 1024;
const MAX_LIMIT = 100;

/** Sentinel accepted by `better-sqlite3` for a process-local in-memory DB. */
const IN_MEMORY_PATH = ":memory:";

// =========================================================================
// Public types
// =========================================================================

export interface MemoryRow {
    namespace: string;
    key: string;
    content: string;
    tags: string;
    updatedAt: number;
}

export interface UpsertInput {
    namespace: string;
    key: string;
    content: string;
    tags?: string[];
}

export interface SearchOptions {
    namespace?: string;
    limit?: number;
}

export interface MemoryStoreOptions {
    /**
     * If set to a positive integer, prune entries whose `updated_at` is
     * older than this many days when the store is opened. Overrides the
     * `TSAGENT_MEMORY_PRUNE_DAYS` environment variable. Pass `null` to
     * explicitly disable even if the env var is set.
     *
     * The auto-prune runs once per open — harmless on subsequent opens
     * because pruned rows are already gone. Failures are logged to stderr
     * and do not prevent the store from opening.
     */
    pruneAfterDays?: number | null;
}

const DEFAULT_NAMESPACE = "default";
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_LIST_LIMIT = 50;

// =========================================================================
// MemoryStore
// =========================================================================

/**
 * SQLite-backed key/value store with FTS5 keyword search.
 *
 * Schema invariants (see the source project's `memory.py`):
 * - `memories_fts` is an **external content** FTS5 table pointed at
 *   `memories` via `content='memories', content_rowid='id'`.
 * - INSERT / DELETE / UPDATE triggers keep the FTS index in sync with the
 *   base table.
 * - `(namespace, key)` is a UNIQUE constraint, and upserts use
 *   `ON CONFLICT DO UPDATE` so re-remembering overwrites cleanly.
 * - `MATCH` queries reference the real table name `memories_fts`, not an
 *   alias; `ORDER BY rank` is left unqualified.
 * - WAL journal mode and `synchronous=NORMAL` for typical agent usage.
 * - Lazy open: the file and schema are created on the first operation,
 *   not at construction. `close()` releases the handle; a later operation
 *   reopens it (idempotently — schema has `IF NOT EXISTS`).
 */
export class MemoryStore {
    readonly path: string;
    private readonly pruneAfterDays: number | null;
    private db: Database.Database | null = null;

    constructor(path: string, options: MemoryStoreOptions = {}) {
        // `resolve(":memory:")` turns the sentinel into `<cwd>/.memory:` — a
        // literal filename that gets created on disk. That defeats the whole
        // point of the in-memory store and produces a real file that leaks
        // into the working directory. Preserve the sentinel verbatim.
        this.path = path === IN_MEMORY_PATH ? IN_MEMORY_PATH : resolve(path);
        // Explicit `null` disables; explicit number wins; otherwise env var.
        if (options.pruneAfterDays === null) {
            this.pruneAfterDays = null;
        } else if (
            typeof options.pruneAfterDays === "number" &&
            Number.isFinite(options.pruneAfterDays) &&
            options.pruneAfterDays > 0
        ) {
            this.pruneAfterDays = options.pruneAfterDays;
        } else {
            this.pruneAfterDays = parsePositiveInt(
                process.env.TSAGENT_MEMORY_PRUNE_DAYS,
            );
        }
    }

    get isOpen(): boolean {
        return this.db !== null;
    }

    /**
     * Bytes on disk, or `0` for an in-memory store (no backing file).
     * Returns `0` on any `statSync` error (file not yet created,
     * permission denied).
     */
    sizeBytes(): number {
        if (this.path === IN_MEMORY_PATH) return 0;
        try {
            return statSync(this.path).size;
        } catch {
            return 0;
        }
    }

    upsert(input: UpsertInput): void {
        assertWithinBounds(input);
        const db = this.ensureOpen();
        const now = Date.now() / 1000;
        const tagsText = (input.tags ?? []).join(", ");
        db.prepare(
            `INSERT INTO memories (namespace, key, content, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         content = excluded.content,
         tags = excluded.tags,
         updated_at = excluded.updated_at`,
        ).run(input.namespace, input.key, input.content, tagsText, now, now);
    }

    forget(namespace: string, key: string): boolean {
        const db = this.ensureOpen();
        const result = db
            .prepare(`DELETE FROM memories WHERE namespace = ? AND key = ?`)
            .run(namespace, key);
        return result.changes > 0;
    }

    search(query: string, options: SearchOptions = {}): MemoryRow[] {
        const fts = sanitizeFts(query);
        if (fts === null) return [];
        const db = this.ensureOpen();
        const limit = clampLimit(options.limit ?? DEFAULT_SEARCH_LIMIT);
        const namespace = options.namespace;

        if (namespace !== undefined) {
            return db
                .prepare(
                    `SELECT m.namespace, m.key, m.content, m.tags,
                  m.updated_at AS updatedAt
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.rowid
           WHERE memories_fts MATCH ? AND m.namespace = ?
           ORDER BY rank
           LIMIT ?`,
                )
                .all(fts, namespace, limit) as MemoryRow[];
        }

        return db
            .prepare(
                `SELECT m.namespace, m.key, m.content, m.tags,
                m.updated_at AS updatedAt
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
            )
            .all(fts, limit) as MemoryRow[];
    }

    list(namespace: string, limit = DEFAULT_LIST_LIMIT): MemoryRow[] {
        const db = this.ensureOpen();
        const clamped = clampLimit(limit);
        return db
            .prepare(
                `SELECT namespace, key, content, tags, updated_at AS updatedAt
         FROM memories
         WHERE namespace = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
            )
            .all(namespace, clamped) as MemoryRow[];
    }

    /**
     * Delete every entry whose `updated_at` is older than `olderThanDays`
     * days. Returns the number of rows deleted.
     *
     * The `memories_ad` FTS trigger runs for each deleted row, keeping the
     * search index in sync automatically. Safe to call multiple times;
     * idempotent when nothing matches.
     *
     * Throws on non-positive or non-finite arguments — a `prune(0)` would
     * delete every entry, which is never what a caller intends.
     */
    prune(olderThanDays: number): number {
        if (!Number.isFinite(olderThanDays) || olderThanDays <= 0) {
            throw new Error(
                `prune: olderThanDays must be a positive finite number (got ${olderThanDays})`,
            );
        }
        const db = this.ensureOpen();
        const cutoff = Date.now() / 1000 - olderThanDays * 86_400;
        const result = db
            .prepare(`DELETE FROM memories WHERE updated_at < ?`)
            .run(cutoff);
        return result.changes;
    }

    close(): void {
        if (this.db !== null) {
            this.db.close();
            this.db = null;
        }
    }

    private ensureOpen(): Database.Database {
        if (this.db !== null) return this.db;

        if (this.path !== IN_MEMORY_PATH) {
            const dir = dirname(this.path);
            if (dir !== "." && dir !== "") {
                mkdirSync(dir, { recursive: true });
            }
        }

        const db = new Database(this.path);
        // WAL is unsupported for `:memory:`, so only apply it to file-backed DBs.
        if (this.path !== IN_MEMORY_PATH) {
            db.pragma("journal_mode = WAL");
        }
        db.pragma("synchronous = NORMAL");
        db.exec(SCHEMA);
        // Set `this.db` before pruning so `prune()`'s internal `ensureOpen()`
        // returns immediately instead of recursing.
        this.db = db;

        if (this.pruneAfterDays !== null) {
            try {
                const removed = this.prune(this.pruneAfterDays);
                if (removed > 0) {
                    process.stderr.write(
                        `[memory] auto-pruned ${removed} entries older than ${this.pruneAfterDays} days\n`,
                    );
                }
            } catch (error) {
                // Non-fatal: log and continue with an unpruned store.
                process.stderr.write(
                    `[memory] auto-prune failed (continuing): ${error instanceof Error ? error.message : String(error)}\n`,
                );
            }
        }

        return db;
    }
}

// =========================================================================
// Bounds enforcement
// =========================================================================

function assertWithinBounds(input: UpsertInput): void {
    if (input.namespace.length === 0) {
        throw new Error("upsert: namespace is empty");
    }
    if (input.namespace.length > MAX_NAMESPACE_LENGTH) {
        throw new Error(
            `upsert: namespace length ${input.namespace.length} exceeds max ${MAX_NAMESPACE_LENGTH}`,
        );
    }
    if (input.key.length === 0) {
        throw new Error("upsert: key is empty");
    }
    if (input.key.length > MAX_KEY_LENGTH) {
        throw new Error(
            `upsert: key length ${input.key.length} exceeds max ${MAX_KEY_LENGTH}`,
        );
    }
    if (input.content.length === 0) {
        throw new Error("upsert: content is empty");
    }
    if (input.content.length > MAX_CONTENT_LENGTH) {
        throw new Error(
            `upsert: content length ${input.content.length} exceeds max ${MAX_CONTENT_LENGTH}`,
        );
    }
    const tags = input.tags ?? [];
    if (tags.length > MAX_TAGS) {
        throw new Error(
            `upsert: ${tags.length} tags exceeds max ${MAX_TAGS}`,
        );
    }
    for (const tag of tags) {
        if (tag.length > MAX_TAG_LENGTH) {
            throw new Error(
                `upsert: tag length ${tag.length} exceeds max ${MAX_TAG_LENGTH}`,
            );
        }
    }
}

function clampLimit(limit: number): number {
    if (!Number.isFinite(limit) || limit < 1) return DEFAULT_SEARCH_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function parsePositiveInt(value: string | undefined): number | null {
    if (value === undefined || value === "") return null;
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  UNIQUE(namespace, key)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  content='memories',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags)
    VALUES (new.id, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', old.id, old.content, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', old.id, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags)
    VALUES (new.id, new.content, new.tags);
END;
`;

// =========================================================================
// FTS query sanitization
// =========================================================================

/**
 * Turn a user query into a safe FTS5 MATCH expression.
 *
 * Each whitespace-separated term is wrapped in double quotes, with embedded
 * double quotes doubled. FTS5 treats the result as a sequence of quoted
 * phrases joined by implicit AND. Returns `null` for empty / whitespace-only
 * input so callers can short-circuit to `[]`.
 */
export function sanitizeFts(query: string): string | null {
    const terms = query
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0);
    if (terms.length === 0) return null;
    return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

// =========================================================================
// Tools
// =========================================================================

/**
 * Build the four memory tools bound to `store`:
 *   - `remember`      (mutate)
 *   - `recall`        (read)
 *   - `forget`        (mutate)
 *   - `list_memories` (read)
 *
 * Every string/array field is bounded — see the `MAX_*` constants above.
 * The bounds match `MemoryStore.upsert`'s runtime checks, so the tool
 * boundary and the store boundary cannot drift.
 */
export function makeMemoryTools(store: MemoryStore): BaseTool[] {
    return [
        makeRememberTool(store),
        makeRecallTool(store),
        makeForgetTool(store),
        makeListMemoriesTool(store),
    ];
}

function makeRememberTool(store: MemoryStore): BaseTool {
    return new FunctionTool({
        name: "remember",
        description:
            "Store or update a memory entry under a namespace and key. " +
            "Re-remembering the same (namespace, key) overwrites the content.",
        permission: "mutate",
        argsSchema: z.object({
            key: z.string().min(1).max(MAX_KEY_LENGTH),
            content: z.string().min(1).max(MAX_CONTENT_LENGTH),
            namespace: z
                .string()
                .max(MAX_NAMESPACE_LENGTH)
                .default(DEFAULT_NAMESPACE),
            tags: z
                .array(z.string().min(1).max(MAX_TAG_LENGTH))
                .max(MAX_TAGS)
                .optional(),
        }),
        fn: ({ key, content, namespace, tags }) => {
            store.upsert({ namespace, key, content, tags: tags ?? [] });
            return `remembered ${namespace}/${key}`;
        },
    });
}

function makeRecallTool(store: MemoryStore): BaseTool {
    return new FunctionTool({
        name: "recall",
        description:
            "Search memories by keyword using FTS5. Returns the best-matching " +
            "entries, ranked by relevance.",
        permission: "read",
        argsSchema: z.object({
            query: z.string().min(1).max(MAX_QUERY_LENGTH),
            namespace: z.string().max(MAX_NAMESPACE_LENGTH).optional(),
            limit: z
                .number()
                .int()
                .positive()
                .max(MAX_LIMIT)
                .default(DEFAULT_SEARCH_LIMIT),
        }),
        fn: ({ query, namespace, limit }) => {
            const options: SearchOptions = { limit };
            if (namespace !== undefined) options.namespace = namespace;
            const rows = store.search(query, options);
            if (rows.length === 0) return "no matching memories";
            return rows.map(formatMemory).join("\n\n");
        },
    });
}

function makeForgetTool(store: MemoryStore): BaseTool {
    return new FunctionTool({
        name: "forget",
        description: "Delete a memory entry identified by namespace and key.",
        permission: "mutate",
        argsSchema: z.object({
            key: z.string().min(1).max(MAX_KEY_LENGTH),
            namespace: z
                .string()
                .max(MAX_NAMESPACE_LENGTH)
                .default(DEFAULT_NAMESPACE),
        }),
        fn: ({ key, namespace }) => {
            const removed = store.forget(namespace, key);
            return removed
                ? `forgot ${namespace}/${key}`
                : `no memory at ${namespace}/${key}`;
        },
    });
}

function makeListMemoriesTool(store: MemoryStore): BaseTool {
    return new FunctionTool({
        name: "list_memories",
        description:
            "List every memory in a namespace, ordered by most recently updated.",
        permission: "read",
        argsSchema: z.object({
            namespace: z
                .string()
                .max(MAX_NAMESPACE_LENGTH)
                .default(DEFAULT_NAMESPACE),
            limit: z
                .number()
                .int()
                .positive()
                .max(MAX_LIMIT)
                .default(DEFAULT_LIST_LIMIT),
        }),
        fn: ({ namespace, limit }) => {
            const rows = store.list(namespace, limit);
            if (rows.length === 0) return "no memories";
            return rows.map(formatMemory).join("\n\n");
        },
    });
}

// =========================================================================
// Formatting
// =========================================================================

function formatMemory(row: MemoryRow): string {
    const lines: string[] = [`[${row.namespace}] ${row.key}`];
    lines.push(`  ${row.content}`);
    if (row.tags.length > 0) {
        lines.push(`  tags: ${row.tags}`);
    }
    return lines.join("\n");
}