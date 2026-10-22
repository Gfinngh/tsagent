import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { check, checkEqual, makeTempDir, runScript } from "./_verify-common.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const mainTsPath = resolve(projectRoot, "main.ts");

function runCli(args: string[], env: Record<string, string>) {
    return spawnSync(process.execPath, ["--import", "tsx", mainTsPath, ...args], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
        encoding: "utf8",
        cwd: projectRoot,
    });
}

runScript(async () => {
    const tmp = makeTempDir("mcp-fail");
    try {
        // 1. Fresh run + MCP failure → exit 1, message, no log
        {
            const logPath = join(tmp.path, "fresh.jsonl");
            const r = runCli(["hello"], {
                MCP_SERVER_COMMAND: "/nonexistent-tsagent-test-command",
                GEMINI_API_KEY: "fake",
                GOOGLE_API_KEY: "fake",
                TSAGENT_LOG_PATH: logPath,
            });
            checkEqual(r.status, 1, "fresh/mcp-fail: exit 1");
            check(
                typeof r.stderr === "string" &&
                r.stderr.includes("MCP server failed to start"),
                "fresh/mcp-fail: stderr message",
            );
            check(!existsSync(logPath), "fresh/mcp-fail: log NOT created");
            // No raw traceback
            check(
                typeof r.stderr === "string" && !r.stderr.includes("at Object."),
                "fresh/mcp-fail: no stack trace",
            );
        }

        // 2. Resume + MCP failure → exit 1, message, dest log NOT created
        {
            const sourcePath = join(tmp.path, "source.jsonl");
            writeFileSync(
                sourcePath,
                JSON.stringify({
                    id: "11111111-1111-1111-1111-111111111111",
                    timestamp: 1,
                    content: [
                        {
                            type: "message",
                            message: {
                                role: "user",
                                content: "hi",
                                toolCalls: [],
                                toolCallId: null,
                                providerOptions: {},
                            },
                        },
                    ],
                }) + "\n",
            );

            const destPath = join(tmp.path, "resume-dest.jsonl");
            const r = runCli(["--resume", "--log", sourcePath], {
                MCP_SERVER_COMMAND: "/nonexistent-tsagent-test-command",
                GEMINI_API_KEY: "fake",
                GOOGLE_API_KEY: "fake",
                TSAGENT_LOG_PATH: destPath,
            });
            checkEqual(r.status, 1, "resume/mcp-fail: exit 1");
            check(
                typeof r.stderr === "string" &&
                r.stderr.includes("MCP server failed to start"),
                "resume/mcp-fail: stderr message",
            );
            check(!existsSync(destPath), "resume/mcp-fail: dest log NOT created");
        }
    } finally {
        tmp.cleanup();
    }
});