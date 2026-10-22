import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkEqual, makeTempDir, runScript, skip } from "./_verify-common.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const mainTsPath = resolve(projectRoot, "main.ts");

function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", mainTsPath, ...args], {
        env: {
            ...process.env,
            // Force MCP to fail fast so each run completes in ~1s
            MCP_SERVER_COMMAND: "/nonexistent-tsagent-test-command",
            GEMINI_API_KEY: "fake",
            GOOGLE_API_KEY: "fake",
            TSAGENT_LOG_PATH: "",
        },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        encoding: "utf8",
        cwd: projectRoot,
    });
}

runScript(async () => {
    const tmp = makeTempDir("approval");
    try {
        // 1. --approve → no non-TTY warning
        {
            const r = runCli(["--approve", "hello"]);
            checkEqual(r.status, 1, "approve: exit 1 (MCP fails, not the warning)");
            check(
                typeof r.stderr === "string" &&
                !r.stderr.includes("stdin is not a TTY"),
                "approve: no non-TTY warning",
            );
        }

        // 2. --deny → no non-TTY warning
        {
            const r = runCli(["--deny", "hello"]);
            checkEqual(r.status, 1, "deny: exit 1");
            check(
                typeof r.stderr === "string" &&
                !r.stderr.includes("stdin is not a TTY"),
                "deny: no non-TTY warning",
            );
        }

        // 3. interactive + non-TTY → warning with guidance
        {
            const r = runCli(["hello"]);
            checkEqual(r.status, 1, "interactive/non-tty: exit 1");
            const stderr = r.stderr as string;
            check(
                stderr.includes("stdin is not a TTY"),
                "interactive/non-tty: warning appears",
            );
            check(
                stderr.includes("default to deny"),
                "interactive/non-tty: warning explains default-deny",
            );
            check(
                stderr.includes("--approve") && stderr.includes("--deny"),
                "interactive/non-tty: warning suggests overrides",
            );
        }

        // 4. interactive + TTY is not testable without a PTY
        skip(
            "interactive/tty: requires a PTY — not testable in this environment",
        );

        // 5. --approve --deny conflict is handled even with MCP failure
        {
            const r = runCli(["--approve", "--deny", "hello"]);
            checkEqual(r.status, 2, "conflict: exit 2");
            check(
                typeof r.stderr === "string" &&
                r.stderr.includes("mutually exclusive"),
                "conflict: stderr message",
            );
        }
    } finally {
        tmp.cleanup();
    }
});