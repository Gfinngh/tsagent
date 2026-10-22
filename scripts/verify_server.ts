import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpConnection, mcpResultToMultipart } from "../src/agent/client.js";
import { textPart } from "../src/agent/tools/multipart.js";
import { check, checkEqual, makeTempDir, runScript, skip } from "./_verify-common.js";

runScript(async () => {
    const tmp = makeTempDir("mcp-server");

    try {
        // Populate a workspace.
        writeFileSync(join(tmp.path, "hello.txt"), "hello world");
        writeFileSync(join(tmp.path, "notes.md"), "# Notes\n\nSome content.");
        writeFileSync(join(tmp.path, ".hidden"), "secret");
        mkdirSync(join(tmp.path, "subdir"));
        writeFileSync(join(tmp.path, "subdir", "nested.txt"), "nested contents");

        // ----- Spawn 1: no TAVILY_API_KEY -----
        const noKeyEnv: Record<string, string> = {
            WORKSPACE_ROOT: tmp.path,
            TAVILY_API_KEY: "",
        };
        const conn1 = new McpConnection("tsagent", {
            command: process.execPath,
            args: ["--import", "tsx", "src/agent/server.ts"],
            env: noKeyEnv,
            connectTimeoutMs: 30_000,
        });

        try {
            await conn1.connect();

            // ----- listTools -----
            const listed = await conn1.listTools();
            const names = listed.map((t) => t.name).sort();
            check(names.includes("calculator"), "listTools: calculator");
            check(names.includes("greet"), "listTools: greet");
            check(names.includes("list_files"), "listTools: list_files");
            check(names.includes("read_file"), "listTools: read_file");
            check(names.includes("write_file"), "listTools: write_file");
            check(names.includes("search_web"), "listTools: search_web");
            check(names.includes("execute_python"), "listTools: execute_python");

            // ----- list_files -----
            {
                const r = await conn1.callTool("list_files", { pattern: "**/*.txt" });
                checkEqual(r.isError, false, "list_files/txt: success");
                const text = (r.content[0] as { text: string }).text;
                const files = JSON.parse(text) as Array<{ path: string; size: number }>;
                check(
                    files.some((f) => f.path === "hello.txt"),
                    "list_files/txt: hello.txt present",
                );
                check(
                    files.some((f) => f.path === "subdir/nested.txt"),
                    "list_files/txt: nested.txt present",
                );
                check(
                    !files.some((f) => f.path === ".hidden"),
                    "list_files/txt: hidden file excluded",
                );
                const hello = files.find((f) => f.path === "hello.txt");
                checkEqual(
                    hello?.size,
                    "hello world".length,
                    "list_files/txt: hello.txt size",
                );
            }

            // ----- list_files: hidden dir skipped -----
            {
                mkdirSync(join(tmp.path, ".git"));
                writeFileSync(join(tmp.path, ".git", "config"), "x");
                const r = await conn1.callTool("list_files", { pattern: "**/*" });
                checkEqual(r.isError, false, "list_files/hidden-dir: success");
                const files = JSON.parse(
                    (r.content[0] as { text: string }).text,
                ) as Array<{ path: string }>;
                check(
                    !files.some((f) => f.path.startsWith(".git/")),
                    "list_files/hidden-dir: .git contents excluded",
                );
            }

            // ----- read_file: success -----
            {
                const r = await conn1.callTool("read_file", { path: "hello.txt" });
                checkEqual(r.isError, false, "read_file/success: isError false");
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.startsWith("[file: hello.txt (11 bytes)]"),
                    "read_file/success: header present",
                );
                check(
                    text.endsWith("hello world"),
                    "read_file/success: content preserved",
                );
            }

            // ----- read_file: absolute path rejected -----
            {
                const r = await conn1.callTool("read_file", { path: "/etc/passwd" });
                checkEqual(r.isError, true, "read_file/absolute: isError true");
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.includes("absolute path rejected"),
                    "read_file/absolute: reason present",
                );
            }

            // ----- read_file: traversal rejected -----
            {
                const r = await conn1.callTool("read_file", { path: "../secret" });
                checkEqual(r.isError, true, "read_file/traversal: isError true");
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.includes("path traversal rejected"),
                    "read_file/traversal: reason present",
                );
            }

            // ----- read_file: missing file -----
            {
                const r = await conn1.callTool("read_file", { path: "missing.txt" });
                checkEqual(r.isError, true, "read_file/missing: isError true");
            }

            // ----- write_file: success -----
            {
                const r = await conn1.callTool("write_file", {
                    path: "out.txt",
                    content: "written content",
                });
                checkEqual(r.isError, false, "write_file/success: isError false");
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.includes("Wrote") && text.includes("out.txt"),
                    "write_file/success: confirmation message",
                );
                // Read it back.
                const r2 = await conn1.callTool("read_file", { path: "out.txt" });
                const readText = (r2.content[0] as { text: string }).text;
                check(
                    readText.endsWith("written content"),
                    "write_file/success: round-trip through read_file",
                );
            }

            // ----- write_file: creates parent dirs -----
            {
                const r = await conn1.callTool("write_file", {
                    path: "deep/nested/path/file.txt",
                    content: "deep",
                });
                checkEqual(r.isError, false, "write_file/deep: isError false");
                const r2 = await conn1.callTool("read_file", {
                    path: "deep/nested/path/file.txt",
                });
                const readText = (r2.content[0] as { text: string }).text;
                check(readText.endsWith("deep"), "write_file/deep: content present");
            }

            // ----- write_file: absolute rejected -----
            {
                const r = await conn1.callTool("write_file", {
                    path: "/tmp/escape.txt",
                    content: "x",
                });
                checkEqual(r.isError, true, "write_file/absolute: isError true");
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.includes("absolute path rejected"),
                    "write_file/absolute: reason present",
                );
            }

            // ----- write_file: traversal rejected -----
            {
                const r = await conn1.callTool("write_file", {
                    path: "../../escape.txt",
                    content: "x",
                });
                checkEqual(r.isError, true, "write_file/traversal: isError true");
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.includes("path traversal rejected"),
                    "write_file/traversal: reason present",
                );
            }

            // ----- search_web: missing key errors cleanly -----
            {
                const r = await conn1.callTool("search_web", { query: "test" });
                checkEqual(r.isError, true, "search_web/no-key: isError true");
                const text = (r.content[0] as { text: string }).text;
                check(
                    text.includes("TAVILY_API_KEY"),
                    "search_web/no-key: reason mentions TAVILY_API_KEY",
                );
            }

            // ----- mcpResultToMultipart round-trip -----
            {
                const r = await conn1.callTool("calculator", { expression: "1 + 1" });
                const parts = mcpResultToMultipart(r, "calculator");
                checkEqual(parts.length, 1, "convert: one part");
                checkEqual(parts[0], textPart("2"), "convert: text part '2'");
            }
        } finally {
            await conn1.close();
        }

        // ----- Spawn 2: with TAVILY_API_KEY (if available) -----
        if (process.env.TAVILY_API_KEY) {
            const conn2 = new McpConnection("tsagent", {
                command: process.execPath,
                args: ["--import", "tsx", "src/agent/server.ts"],
                env: { WORKSPACE_ROOT: tmp.path },
                connectTimeoutMs: 30_000,
            });
            try {
                await conn2.connect();
                const r = await conn2.callTool("search_web", {
                    query: "typescript",
                    maxResults: 2,
                });
                checkEqual(r.isError, false, "search_web/live: isError false");
                const text = (r.content[0] as { text: string }).text;
                check(text.length > 0, "search_web/live: non-empty results");
            } catch (e) {
                // Live search may fail transiently.
                skip(`search_web/live: ${(e as Error).message}`);
            } finally {
                await conn2.close();
            }
        } else {
            skip("search_web/live: no TAVILY_API_KEY");
        }
    } finally {
        tmp.cleanup();
    }
});