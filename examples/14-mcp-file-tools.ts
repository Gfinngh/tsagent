/**
 * 14 — Workspace file tools
 *
 * The three file tools (`list_files`, `read_file`, `write_file`)
 * confine every path to a `workspaceRoot`. Absolute paths, `..`
 * traversal, and symlinks that resolve outside the root are all
 * rejected before any filesystem access happens.
 *
 * This example uses `makeFileTools()` directly (no MCP subprocess).
 * The tools are identical to what the MCP server exposes — the
 * difference is only who owns the connection.
 *
 *   npx tsx examples/14-mcp-file-tools.ts
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFileTools } from "../src/agent/tools/workspace.js";
import { ensureDir, loadEnv, section } from "./_common.js";

loadEnv();

const WORKSPACE = ".examples/workspace-files";

async function main(): Promise<void> {
    section("setup");
    rmSync(WORKSPACE, { recursive: true, force: true });
    ensureDir(WORKSPACE);
    writeFileSync(join(WORKSPACE, "hello.txt"), "hello world\n");
    writeFileSync(join(WORKSPACE, "notes.md"), "# Notes\n\nsome notes\n");
    ensureDir(join(WORKSPACE, "subdir"));
    writeFileSync(join(WORKSPACE, "subdir", "nested.txt"), "nested\n");
    writeFileSync(join(WORKSPACE, ".hidden"), "should not be listed\n");
    console.log(`workspace: ${WORKSPACE}`);

    const tools = makeFileTools({ workspaceRoot: WORKSPACE });
    const byName = new Map(tools.map((t) => [t.name, t]));

    const list = byName.get("list_files");
    const read = byName.get("read_file");
    const write = byName.get("write_file");

    if (list === undefined || read === undefined || write === undefined) {
        console.error("expected three tools");
        process.exit(1);
    }

    section("list_files");
    {
        const result = await list.run({ pattern: "**/*" });
        const entries = JSON.parse(String(result[0])) as Array<{
            path: string;
            size: number;
        }>;
        for (const entry of entries) {
            console.log(`  ${entry.path.padEnd(20)} ${entry.size} bytes`);
        }
        console.log("  (hidden segments are skipped)");
    }

    section('read_file({ path: "hello.txt" })');
    {
        const result = await read.run({ path: "hello.txt" });
        console.log("---");
        console.log(String(result[0]));
        console.log("---");
    }

    section('write_file({ path: "created.txt", content: "..." })');
    {
        const result = await write.run({
            path: "created.txt",
            content: "written by write_file\n",
        });
        console.log(String(result[0]));

        // Verify with read_file.
        const readBack = await read.run({ path: "created.txt" });
        console.log("---");
        console.log(String(readBack[0]));
        console.log("---");
    }

    section("write_file({ path: 'deep/nested/new.txt' }) — parents auto-created");
    {
        const result = await write.run({
            path: "deep/nested/new.txt",
            content: "auto-mkdir\n",
        });
        console.log(String(result[0]));
    }

    section("path confinement");
    const probes: Array<[string, string]> = [
        ["/etc/passwd", "absolute path rejected"],
        ["../escape.txt", "path traversal rejected"],
        ["subdir/../../escape.txt", "path traversal rejected"],
    ];
    for (const [path, label] of probes) {
        try {
            await read.run({ path });
            console.log(`  ${path}  → UNEXPECTEDLY ALLOWED`);
        } catch (error) {
            console.log(
                `  ${path}  → rejected: ${error instanceof Error ? error.message : String(error)}`,
            );
            void label;
        }
    }

    section("notes");
    console.log(
        "Same tools are exposed by the MCP server (see examples/07-mcp-tools.ts).",
    );
    console.log(
        "Workspace root is determined by WORKSPACE_ROOT (env) or the directory",
    );
    console.log("passed to makeFileTools / spawnMcpConnection.");
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});