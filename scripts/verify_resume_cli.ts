import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
    makeEvent,
    messageContentItem,
} from "../src/agent/schemas.js";
import { check, checkEqual, makeTempDir, runScript } from "./_verify-common.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const mainTsPath = resolve(projectRoot, "main.ts");

function runCli(args: string[], env: Record<string, string>) {
    return spawnSync(process.execPath, ["--import", "tsx", mainTsPath, ...args], {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
        encoding: "utf8",
        cwd: projectRoot,
    });
}

runScript(async () => {
    const tmp = makeTempDir("resume-cli");
    try {
        // Fixture: completed run (user + assistant text, no tool activity)
        const completedPath = join(tmp.path, "completed.jsonl");
        const userEvent = makeEvent([
            messageContentItem({ role: "user", content: "hi" }),
        ]);
        const assistantEvent = makeEvent([
            messageContentItem({ role: "assistant", content: "hello" }),
        ]);
        writeFileSync(
            completedPath,
            JSON.stringify(userEvent) + "\n" + JSON.stringify(assistantEvent) + "\n",
        );

        // 1. --resume without --log → exit 2
        {
            const r = runCli(["--resume"], {});
            checkEqual(r.status, 2, "resume/no-log: exit 2");
            check(
                typeof r.stderr === "string" && r.stderr.includes("requires --log"),
                "resume/no-log: stderr message",
            );
        }

        // 2. --resume --log <nonexistent> → exit 2
        {
            const r = runCli(
                ["--resume", "--log", join(tmp.path, "nope.jsonl")],
                {},
            );
            checkEqual(r.status, 2, "resume/nonexistent: exit 2");
            check(
                typeof r.stderr === "string" &&
                r.stderr.includes("source log not found"),
                "resume/nonexistent: stderr message",
            );
        }

        // 3. --resume --log <completed>, no prompt → exit 0, "already complete",
        //    dest log NOT created
        {
            const destPath = join(tmp.path, "should-not-exist.jsonl");
            const r = runCli(["--resume", "--log", completedPath], {
                TSAGENT_LOG_PATH: destPath,
            });
            checkEqual(r.status, 0, "resume/complete: exit 0");
            check(
                typeof r.stderr === "string" && r.stderr.includes("already complete"),
                "resume/complete: stderr message",
            );
            check(!existsSync(destPath), "resume/complete: dest log NOT created");
        }

        // 4. --resume --log <completed> with dest == source → exit 2
        //    (Requires a follow-up prompt so the no-op path is skipped.)
        {
            const r = runCli(
                ["--resume", "--log", completedPath, "follow-up"],
                { TSAGENT_LOG_PATH: completedPath },
            );
            checkEqual(r.status, 2, "resume/same-path: exit 2");
            check(
                typeof r.stderr === "string" &&
                r.stderr.includes("cannot write onto the source log"),
                "resume/same-path: stderr message",
            );
        }

        // 5. Source log is not modified by a no-op resume
        {
            // Fresh fixture to isolate from test 3's activity.
            const sourcePath = join(tmp.path, "source-preserved.jsonl");
            const ev1 = makeEvent([
                messageContentItem({ role: "user", content: "kept" }),
            ]);
            const ev2 = makeEvent([
                messageContentItem({ role: "assistant", content: "kept reply" }),
            ]);
            const originalBytes = JSON.stringify(ev1) + "\n" + JSON.stringify(ev2) + "\n";
            writeFileSync(sourcePath, originalBytes);

            const r = runCli(["--resume", "--log", sourcePath], {
                TSAGENT_LOG_PATH: join(tmp.path, "different-dest.jsonl"),
            });
            checkEqual(r.status, 0, "source-preserved: exit 0");

            // Re-read the source; must be byte-identical.
            const { readFileSync } = await import("node:fs");
            const after = readFileSync(sourcePath, "utf8");
            checkEqual(after, originalBytes, "source-preserved: file unchanged");
        }
    } finally {
        tmp.cleanup();
    }
});