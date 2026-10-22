import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpConnection } from "../src/agent/client.js";
import { check, checkEqual, makeTempDir, runScript } from "./_verify-common.js";

runScript(async () => {
    const tmp = makeTempDir("write-tool");
    try {
        const conn = new McpConnection("tsagent", {
            command: process.execPath,
            args: ["--import", "tsx", "src/agent/server.ts"],
            env: { WORKSPACE_ROOT: tmp.path },
            connectTimeoutMs: 30_000,
        });

        try {
            await conn.connect();

            // ----- Basic write -----
            {
                const r = await conn.callTool("write_file", {
                    path: "a.txt",
                    content: "first",
                });
                checkEqual(r.isError, false, "basic: isError false");
                const onDisk = readFileSync(join(tmp.path, "a.txt"), "utf8");
                checkEqual(onDisk, "first", "basic: file written correctly");
            }

            // ----- Overwrite -----
            {
                await conn.callTool("write_file", { path: "a.txt", content: "second" });
                const onDisk = readFileSync(join(tmp.path, "a.txt"), "utf8");
                checkEqual(onDisk, "second", "overwrite: content replaced");
            }

            // ----- UTF-8 round-trip -----
            {
                await conn.callTool("write_file", {
                    path: "utf8.txt",
                    content: "hello 世界 🎉",
                });
                const onDisk = readFileSync(join(tmp.path, "utf8.txt"), "utf8");
                checkEqual(onDisk, "hello 世界 🎉", "utf8: content preserved");
            }

            // ----- Deep parent auto-creation -----
            {
                await conn.callTool("write_file", {
                    path: "a/b/c/d/file.txt",
                    content: "deep",
                });
                const onDisk = readFileSync(join(tmp.path, "a/b/c/d/file.txt"), "utf8");
                checkEqual(onDisk, "deep", "deep: parent dirs created");
            }

            // ----- Absolute path rejected -----
            for (const bad of ["/etc/passwd", "/tmp/x", "C:\\Windows\\x"]) {
                const r = await conn.callTool("write_file", { path: bad, content: "x" });
                checkEqual(r.isError, true, `absolute/${bad}: isError true`);
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.includes("absolute path rejected"),
                    `absolute/${bad}: reason present`,
                );
            }

            // ----- Traversal rejected -----
            for (const bad of ["..", "../x", "../../x", "a/../..", "a/../../x"]) {
                const r = await conn.callTool("write_file", { path: bad, content: "x" });
                checkEqual(r.isError, true, `traversal/${bad}: isError true`);
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.includes("path traversal rejected"),
                    `traversal/${bad}: reason present`,
                );
            }

            // ----- Empty path rejected -----
            {
                const r = await conn.callTool("write_file", { path: "", content: "x" });
                checkEqual(r.isError, true, "empty-path: isError true");
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.includes("path is empty"),
                    "empty-path: reason present",
                );
            }

            // ----- Confirm nothing escaped the workspace -----
            // None of the rejected paths should have been created anywhere.
            {
                const r = await conn.callTool("list_files", { pattern: "**/*" });
                const files = JSON.parse(
                    (r.content[0] as { text: string }).text,
                ) as Array<{ path: string }>;
                check(
                    !files.some((f) => f.path.includes("..")),
                    "escape: no traversal paths in workspace",
                );
            }
        } finally {
            await conn.close();
        }
    } finally {
        tmp.cleanup();
    }
});