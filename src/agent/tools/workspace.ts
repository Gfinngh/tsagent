import {
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    statSync,
    writeFileSync,
    type Dirent,
} from "node:fs";
import {
    basename,
    dirname,
    isAbsolute,
    join,
    normalize,
    resolve,
} from "node:path";
import { z } from "zod";
import { BaseTool, FunctionTool, ToolError } from "./base.js";

const MAX_READ_BYTES = 1_048_576; // 1 MiB
const MAX_LIST_RESULTS = 200;

export interface WorkspaceOptions {
    workspaceRoot: string;
}

/**
 * Build the three workspace file tools, confined to `workspaceRoot`.
 * Returns a fresh tool set each call — no shared mutable state.
 */
export function makeFileTools(options: WorkspaceOptions): BaseTool[] {
    const root = resolve(options.workspaceRoot);
    return [
        makeListFilesTool(root),
        makeReadFileTool(root),
        makeWriteFileTool(root),
    ];
}

// =========================================================================
// list_files
// =========================================================================

function makeListFilesTool(root: string): BaseTool {
    return new FunctionTool({
        name: "list_files",
        description:
            "List files under the workspace that match a glob pattern. " +
            "Hidden path segments (names starting with '.') are skipped. " +
            "Symbolic links are not listed.",
        argsSchema: z.object({
            pattern: z.string().default("**/*"),
        }),
        fn: ({ pattern }) => {
            const regex = globToRegex(pattern);
            const results: Array<{ path: string; size: number }> = [];
            for (const entry of walkFiles(root)) {
                if (!regex.test(entry.relPath)) continue;
                results.push({ path: entry.relPath, size: entry.size });
                if (results.length >= MAX_LIST_RESULTS) break;
            }
            // Return a single JSON string so the tool result is one coherent
            // content item, not N items — matching the source project's
            // `[json.dumps(results)]` contract. The model sees the whole list
            // at once.
            return JSON.stringify(results, null, 2);
        },
    });
}

// =========================================================================
// read_file
// =========================================================================

function makeReadFileTool(root: string): BaseTool {
    return new FunctionTool({
        name: "read_file",
        description:
            "Read a UTF-8 text file from the workspace. Paths must be " +
            "workspace-relative; absolute paths, traversal segments, and " +
            "symlinks that resolve outside the workspace are rejected.",
        argsSchema: z.object({
            path: z.string(),
        }),
        fn: ({ path: relPath }) => {
            const abs = resolveWorkspacePath(root, relPath);
            let stat;
            try {
                stat = statSync(abs);
            } catch (error) {
                throw new ToolError(`cannot stat file: ${(error as Error).message}`);
            }
            if (!stat.isFile()) throw new ToolError(`not a regular file: ${relPath}`);

            const buf = readFileSync(abs);
            const originalSize = buf.length;
            const truncated = originalSize > MAX_READ_BYTES;
            const slice = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;
            const text = slice.toString("utf8");

            // Detect binary content: a replacement character in the decoded text
            // means the original bytes were not valid UTF-8.
            if (!truncated && text.includes("\uFFFD")) {
                throw new ToolError(`file is not valid UTF-8: ${relPath}`);
            }

            const header = truncated
                ? `[file: ${relPath} (${originalSize} bytes, showing first ${MAX_READ_BYTES})]`
                : `[file: ${relPath} (${originalSize} bytes)]`;
            return `${header}\n${text}`;
        },
    });
}

// =========================================================================
// write_file
// =========================================================================

function makeWriteFileTool(root: string): BaseTool {
    return new FunctionTool({
        name: "write_file",
        description:
            "Write a UTF-8 text file into the workspace. Parent directories are " +
            "created automatically. Paths must be workspace-relative; absolute " +
            "paths, traversal segments, and symlinks that resolve outside the " +
            "workspace are rejected.",
        permission: "mutate",
        argsSchema: z.object({
            path: z.string(),
            content: z.string(),
        }),
        fn: ({ path: relPath, content }) => {
            const abs = resolveWorkspacePath(root, relPath);
            const dir = dirname(abs);
            mkdirSync(dir, { recursive: true });
            writeFileSync(abs, content, "utf8");
            return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${relPath}`;
        },
    });
}

// =========================================================================
// Path confinement
// =========================================================================

/**
 * Resolve a workspace-relative path against `root`, rejecting:
 * - empty strings
 * - absolute paths (POSIX or Windows drive-letter)
 * - any `..` segment
 * - any resolved path that lexically escapes `root`
 * - any resolved path that **follows a symlink outside** `root`
 *
 * The lexical check catches the simple cases. The realpath check catches
 * a symlink at any component of the path (e.g. `escape -> /etc/passwd`,
 * or `dir -> /etc`) that would otherwise be followed by the underlying
 * `readFileSync` / `writeFileSync` call even though the lexical path
 * looks contained. Legitimate symlinks that resolve *inside* the
 * workspace are allowed.
 *
 * Threat model: defends against symlinks already present in a shared
 * workspace. Does NOT defend against a concurrent adversary who can
 * replace a directory with a symlink between the check and the fs
 * call — that requires `O_NOFOLLOW`/`openat` syscalls and is out of
 * scope.
 */
export function resolveWorkspacePath(root: string, relPath: string): string {
    if (relPath.length === 0) throw new ToolError("path is empty");
    if (isAbsolute(relPath)) {
        throw new ToolError(`absolute path rejected: ${relPath}`);
    }
    if (/^[a-zA-Z]:[\\/]/.test(relPath)) {
        throw new ToolError(`absolute path rejected: ${relPath}`);
    }
    for (const segment of relPath.split(/[\\/]/)) {
        if (segment === "..") {
            throw new ToolError(`path traversal rejected: ${relPath}`);
        }
    }
    const resolved = resolve(root, normalize(relPath));
    if (!isPathInside(resolved, root)) {
        throw new ToolError(`path escapes workspace: ${relPath}`);
    }

    // Symlink defense. `realpathSync` of the deepest existing prefix
    // follows every symlink along the way; if any of them redirect outside
    // the realpath'd root, reject. This catches both file symlinks
    // (`escape-file.txt -> /etc/passwd`) and directory symlinks
    // (`escape-dir -> /etc`) even for write targets that do not exist yet.
    let realRoot: string;
    try {
        realRoot = realpathSync(root);
    } catch (error) {
        throw new ToolError(
            `workspace root is not accessible: ${(error as Error).message}`,
        );
    }
    const realResolved = realpathOfDeepest(resolved);
    if (!isPathInside(realResolved, realRoot)) {
        throw new ToolError(
            `path resolves outside workspace via symlink: ${relPath}`,
        );
    }

    return resolved;
}

/**
 * Return the realpath of the deepest existing prefix of `path`, with
 * the non-existing suffix re-attached lexically.
 *
 * Used by `resolveWorkspacePath` so we can verify containment even when
 * the leaf file does not exist yet — `write_file` creates the file after
 * the check, but the *parent* directories it walks through must already
 * be contained.
 *
 * Example: for `/work/a/b/c` where only `/work/a` exists,
 * `realpath(/work/a)` is looked up, then `b/c` is appended.
 */
function realpathOfDeepest(path: string): string {
    let current = path;
    const parts: string[] = [];
    // Bounded walk so a pathological input cannot loop indefinitely.
    for (let i = 0; i < 256; i += 1) {
        try {
            const realCurrent = realpathSync(current);
            return parts.length === 0
                ? realCurrent
                : join(realCurrent, ...parts);
        } catch {
            // ENOENT (or similar) — walk up one level.
        }
        const parent = dirname(current);
        if (parent === current) {
            // Reached the filesystem root without finding an existing prefix.
            // Treat as a failure: even `/` should always exist.
            throw new ToolError(`path resolution failed: ${path}`);
        }
        parts.unshift(basename(current));
        current = parent;
    }
    throw new ToolError(`path resolution failed (depth limit): ${path}`);
}

function isPathInside(child: string, parent: string): boolean {
    if (child === parent) return true;
    const normalizedParent = parent.endsWith("/") ? parent : parent + "/";
    return child.startsWith(normalizedParent);
}

// =========================================================================
// Filesystem walk
// =========================================================================

function* walkFiles(
    root: string,
    current = "",
): Generator<{ relPath: string; absPath: string; size: number }> {
    const dir = current === "" ? root : join(root, current);
    let entries: Dirent<string>[];
    try {
        entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
        return;
    }
    for (const entry of entries) {
        const name = entry.name;
        if (name.startsWith(".")) continue;
        const relPath = current === "" ? name : `${current}/${name}`;
        const absPath = join(dir, name);
        if (entry.isDirectory()) {
            yield* walkFiles(root, relPath);
        } else if (entry.isFile()) {
            // `entry.isFile()` is false for symlinks, so symlinks are skipped.
            // Following them would be pointless (read_file would reject an
            // external escape anyway) and could mislead the model into
            // thinking it can read a file it cannot.
            try {
                yield { relPath, absPath, size: statSync(absPath).size };
            } catch {
                // Skip unreadable files silently; the model sees an incomplete
                // list rather than a whole-tool failure.
            }
        }
    }
}

// =========================================================================
// Glob
// =========================================================================

/** Minimal glob → regex supporting `*`, `**`, and `?`. */
function globToRegex(pattern: string): RegExp {
    let regex = "^";
    let i = 0;
    while (i < pattern.length) {
        const ch = pattern[i]!;
        if (ch === "*" && pattern[i + 1] === "*") {
            if (pattern[i + 2] === "/") {
                regex += "(?:.*/)?";
                i += 3;
            } else {
                regex += ".*";
                i += 2;
            }
        } else if (ch === "*") {
            regex += "[^/]*";
            i += 1;
        } else if (ch === "?") {
            regex += "[^/]";
            i += 1;
        } else if (ch === ".") {
            regex += "\\.";
            i += 1;
        } else {
            regex += ch.replace(/[+()[\]{}^$|\\]/g, "\\$&");
            i += 1;
        }
    }
    regex += "$";
    return new RegExp(regex);
}