/**
 * Verification: symlink escapes must be rejected by `read_file` and
 * `write_file`, while symlinks that stay inside the workspace must be
 * allowed (they are a legitimate filesystem feature).
 *
 * Covers:
 *   - file symlink → outside                → rejected
 *   - directory symlink → outside           → rejected
 *   - file symlink → inside                 → allowed (read + write)
 *   - write to a new path under a real dir  → allowed
 *   - write through a dir symlink → outside → rejected
 *
 * This runs against a real MCP subprocess, a real filesystem, and real
 * symlinks created with `fs.symlinkSync`. No fakes.
 */

import {
    mkdirSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { McpConnection } from "../src/agent/client.js";
import { check, checkEqual, makeTempDir, runScript } from "./_verify-common.js";

runScript(async () => {
    const tmp = makeTempDir("workspace-symlinks");
    const workspace = join(tmp.path, "workspace");
    const outside = join(tmp.path, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });

    // Legitimate content inside the workspace.
    writeFileSync(join(workspace, "inside.txt"), "inside content");

    // Secret content outside the workspace that must NOT be readable.
    writeFileSync(join(outside, "secret.txt"), "secret content");
    writeFileSync(join(outside, "target.txt"), "original");

    // ---- Symlink fixtures ----

    // (1) file symlink inside workspace → OUTSIDE
    symlinkSync(join(outside, "secret.txt"), join(workspace, "escape-file.txt"));

    // (2) directory symlink inside workspace → OUTSIDE
    symlinkSync(outside, join(workspace, "escape-dir"));

    // (3) file symlink inside workspace → INSIDE (legitimate)
    symlinkSync(join(workspace, "inside.txt"), join(workspace, "alias.txt"));

    // (4) file symlink inside workspace → OUTSIDE (write target)
    symlinkSync(join(outside, "target.txt"), join(workspace, "escape-write.txt"));

    // (5) file symlink inside workspace → INSIDE (write target, legitimate)
    symlinkSync(
        join(workspace, "inside.txt"),
        join(workspace, "alias-overwrite.txt"),
    );

    const conn = new McpConnection("tsagent", {
        command: process.execPath,
        args: ["--import", "tsx", "src/agent/server.ts"],
        env: { WORKSPACE_ROOT: workspace },
        connectTimeoutMs: 30_000,
    });

    try {
        await conn.connect();

        // ===== read_file: baseline (no symlink) =====
        {
            const r = await conn.callTool("read_file", { path: "inside.txt" });
            checkEqual(r.isError, false, "read/baseline: isError false");
            const text = (r.content[0] as { text: string }).text;
            check(
                text.endsWith("inside content"),
                "read/baseline: content preserved",
            );
        }

        // ===== read_file: file symlink escape =====
        {
            const r = await conn.callTool("read_file", { path: "escape-file.txt" });
            checkEqual(r.isError, true, "read/file-symlink-escape: isError true");
            const text = (r.content[0] as { text: string }).text;
            check(
                text.includes("outside workspace via symlink"),
                `read/file-symlink-escape: rejection reason (got: ${text})`,
            );
        }

        // ===== read_file: dir symlink escape =====
        {
            const r = await conn.callTool("read_file", {
                path: "escape-dir/secret.txt",
            });
            checkEqual(r.isError, true, "read/dir-symlink-escape: isError true");
            const text = (r.content[0] as { text: string }).text;
            check(
                text.includes("outside workspace via symlink"),
                `read/dir-symlink-escape: rejection reason (got: ${text})`,
            );
        }

        // ===== read_file: internal symlink allowed =====
        {
            const r = await conn.callTool("read_file", { path: "alias.txt" });
            checkEqual(r.isError, false, "read/internal-symlink: isError false");
            const text = (r.content[0] as { text: string }).text;
            check(
                text.endsWith("inside content"),
                "read/internal-symlink: content matches target",
            );
        }

        // ===== write_file: file symlink escape =====
        {
            const r = await conn.callTool("write_file", {
                path: "escape-write.txt",
                content: "OVERWRITTEN",
            });
            checkEqual(r.isError, true, "write/file-symlink-escape: isError true");
            const text = (r.content[0] as { text: string }).text;
            check(
                text.includes("outside workspace via symlink"),
                `write/file-symlink-escape: rejection reason (got: ${text})`,
            );
            // The outside file must be untouched.
            const untouched = readFileSync(join(outside, "target.txt"), "utf8");
            checkEqual(untouched, "original", "write/file-symlink-escape: target untouched");
        }

        // ===== write_file: dir symlink escape =====
        {
            const r = await conn.callTool("write_file", {
                path: "escape-dir/new-file.txt",
                content: "should not land outside",
            });
            checkEqual(r.isError, true, "write/dir-symlink-escape: isError true");
            const text = (r.content[0] as { text: string }).text;
            check(
                text.includes("outside workspace via symlink"),
                `write/dir-symlink-escape: rejection reason (got: ${text})`,
            );
        }

        // ===== write_file: brand-new file, no symlink, allowed =====
        {
            const r = await conn.callTool("write_file", {
                path: "new-file.txt",
                content: "fresh file",
            });
            checkEqual(r.isError, false, "write/new-file: isError false");
            const onDisk = readFileSync(join(workspace, "new-file.txt"), "utf8");
            checkEqual(onDisk, "fresh file", "write/new-file: content on disk");
        }

        // ===== write_file: internal symlink allowed (write through it) =====
        {
            const r = await conn.callTool("write_file", {
                path: "alias-overwrite.txt",
                content: "updated via alias",
            });
            checkEqual(r.isError, false, "write/internal-symlink: isError false");
            // The symlink target (`inside.txt`) received the write.
            const target = readFileSync(join(workspace, "inside.txt"), "utf8");
            checkEqual(target, "updated via alias", "write/internal-symlink: target updated");
        }

        // ===== list_files: symlinks are not listed =====
        {
            const r = await conn.callTool("list_files", { pattern: "**/*" });
            checkEqual(r.isError, false, "list/symlinks: isError false");
            const entries = JSON.parse(
                (r.content[0] as { text: string }).text,
            ) as Array<{ path: string }>;
            const paths = entries.map((e) => e.path);
            check(
                !paths.includes("escape-file.txt"),
                "list/symlinks: file symlink not listed",
            );
            check(
                !paths.includes("escape-dir"),
                "list/symlinks: dir symlink not listed",
            );
            check(
                !paths.includes("alias.txt"),
                "list/symlinks: internal symlink not listed",
            );
            check(
                paths.includes("inside.txt"),
                "list/symlinks: regular file still listed",
            );
        }
    } finally {
        await conn.close();
        tmp.cleanup();
    }
});