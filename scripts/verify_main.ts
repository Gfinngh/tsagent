import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkEqual, makeTempDir, runScript } from "./_verify-common.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const mainTsPath = resolve(projectRoot, "main.ts");

function runCli(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, ["--import", "tsx", mainTsPath, ...args], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        encoding: "utf8",
        cwd: projectRoot,
    });
}

runScript(async () => {
    const tmp = makeTempDir("cli");
    try {
        // 1. --help
        {
            const r = runCli(["--help"]);
            checkEqual(r.status, 0, "--help: exit 0");
            check(
                typeof r.stdout === "string" && r.stdout.includes("Usage:"),
                "--help: usage printed to stdout",
            );
        }

        // 2. --approve --deny → exit 2
        {
            const r = runCli(["--approve", "--deny", "hello"]);
            checkEqual(r.status, 2, "--approve --deny: exit 2");
            check(
                typeof r.stderr === "string" &&
                r.stderr.includes("mutually exclusive"),
                "--approve --deny: stderr message",
            );
        }

        // 3. no prompt, no resume → exit 2
        {
            const r = runCli([]);
            checkEqual(r.status, 2, "no-prompt: exit 2");
            check(
                typeof r.stderr === "string" && r.stderr.includes("missing prompt"),
                "no-prompt: stderr message",
            );
        }

        // 4. unknown flag → exit 2
        {
            const r = runCli(["--bogus-flag", "hello"]);
            checkEqual(r.status, 2, "unknown-flag: exit 2");
        }

        // 5. --resume without --log → exit 2
        {
            const r = runCli(["--resume"]);
            checkEqual(r.status, 2, "resume-without-log: exit 2");
            check(
                typeof r.stderr === "string" &&
                r.stderr.includes("requires --log"),
                "resume-without-log: stderr message",
            );
        }
    } finally {
        tmp.cleanup();
    }
});