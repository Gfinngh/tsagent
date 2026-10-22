import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
    LlmClientProtocol,
    LlmRequest,
    LlmResponse,
} from "../src/agent/llm.js";
import { runProbeModels } from "../probe-models.js";
import { check, checkEqual, runScript, skip } from "./_verify-common.js";

function okClient(text = "ok"): (model: string) => LlmClientProtocol {
    return () => ({
        async generate(_req: LlmRequest): Promise<LlmResponse> {
            return {
                text,
                toolCalls: [],
                usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
                providerOptions: {},
                errorMessage: null,
                errorMetadata: {},
            };
        },
    });
}

function errClient(
    message: string,
): (model: string) => LlmClientProtocol {
    return () => ({
        async generate(_req: LlmRequest): Promise<LlmResponse> {
            return {
                text: null,
                toolCalls: [],
                usage: null,
                providerOptions: {},
                errorMessage: message,
                errorMetadata: { errorType: "unknown" },
            };
        },
    });
}

runScript(async () => {
    // ===== 1. No API key, no factory → exit 2 =====
    {
        const origGem = process.env.GEMINI_API_KEY;
        const origGoogle = process.env.GOOGLE_API_KEY;
        delete process.env.GEMINI_API_KEY;
        delete process.env.GOOGLE_API_KEY;
        try {
            const summary = await runProbeModels();
            checkEqual(summary.exitCode, 2, "no-key: exit 2");
            check(
                summary.error?.includes("GEMINI_API_KEY") ?? false,
                "no-key: error mentions key",
            );
            checkEqual(summary.results.length, 0, "no-key: no results");
        } finally {
            if (origGem !== undefined) process.env.GEMINI_API_KEY = origGem;
            if (origGoogle !== undefined) process.env.GOOGLE_API_KEY = origGoogle;
        }
    }

    // ===== 2. All succeed → exit 0 =====
    {
        const summary = await runProbeModels({
            models: ["m1", "m2"],
            clientFactory: okClient("ok"),
        });
        checkEqual(summary.exitCode, 0, "all-ok: exit 0");
        checkEqual(summary.okCount, 2, "all-ok: two successes");
        checkEqual(summary.failCount, 0, "all-ok: zero failures");
        checkEqual(summary.results.length, 2, "all-ok: two results");
        checkEqual(summary.results[0]?.ok, true, "all-ok: result 1 ok");
        checkEqual(summary.results[0]?.detail, "ok", "all-ok: detail is model text");
    }

    // ===== 3. All fail → exit 1 =====
    {
        const summary = await runProbeModels({
            models: ["m1", "m2"],
            clientFactory: errClient("bad model"),
        });
        checkEqual(summary.exitCode, 1, "all-fail: exit 1");
        checkEqual(summary.okCount, 0, "all-fail: zero successes");
        checkEqual(summary.failCount, 2, "all-fail: two failures");
        checkEqual(summary.results[0]?.ok, false, "all-fail: result 1 failed");
        checkEqual(
            summary.results[0]?.detail,
            "bad model",
            "all-fail: error detail preserved",
        );
    }

    // ===== 4. Some succeed → exit 0 =====
    {
        let count = 0;
        const factory: (model: string) => LlmClientProtocol = () => {
            const idx = count++;
            return {
                async generate(_req: LlmRequest): Promise<LlmResponse> {
                    if (idx === 1) {
                        return {
                            text: null,
                            toolCalls: [],
                            usage: null,
                            providerOptions: {},
                            errorMessage: "failed",
                            errorMetadata: {},
                        };
                    }
                    return {
                        text: "ok",
                        toolCalls: [],
                        usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 },
                        providerOptions: {},
                        errorMessage: null,
                        errorMetadata: {},
                    };
                },
            };
        };
        const summary = await runProbeModels({
            models: ["m1", "m2", "m3"],
            clientFactory: factory,
        });
        checkEqual(summary.exitCode, 0, "some-ok: exit 0");
        checkEqual(summary.okCount, 2, "some-ok: 2 successes");
        checkEqual(summary.failCount, 1, "some-ok: 1 failure");
    }

    // ===== 5. Factory receives models in order =====
    {
        const seen: string[] = [];
        const factory: (model: string) => LlmClientProtocol = (model) => {
            seen.push(model);
            return {
                async generate(): Promise<LlmResponse> {
                    return {
                        text: "ok",
                        toolCalls: [],
                        usage: null,
                        providerOptions: {},
                        errorMessage: null,
                        errorMetadata: {},
                    };
                },
            };
        };
        await runProbeModels({ models: ["a", "b", "c"], clientFactory: factory });
        checkEqual(seen, ["a", "b", "c"], "factory: receives each model in order");
    }

    // ===== 6. Client throws → captured as failure =====
    {
        const factory: (model: string) => LlmClientProtocol = () => ({
            async generate(_req: LlmRequest): Promise<LlmResponse> {
                throw new Error("transport exploded");
            },
        });
        const summary = await runProbeModels({
            models: ["m"],
            clientFactory: factory,
        });
        checkEqual(summary.exitCode, 1, "throw: exit 1");
        checkEqual(summary.results[0]?.ok, false, "throw: result failed");
        check(
            summary.results[0]?.detail.includes("transport exploded") ?? false,
            "throw: exception message preserved",
        );
    }

    // ===== 7. Elapsed time recorded =====
    {
        const factory: (model: string) => LlmClientProtocol = () => ({
            async generate(): Promise<LlmResponse> {
                await new Promise((r) => setTimeout(r, 60));
                return {
                    text: "ok",
                    toolCalls: [],
                    usage: null,
                    providerOptions: {},
                    errorMessage: null,
                    errorMetadata: {},
                };
            },
        });
        const summary = await runProbeModels({
            models: ["m"],
            clientFactory: factory,
        });
        check(
            (summary.results[0]?.elapsedMs ?? 0) >= 50,
            `elapsed: recorded >= 50ms (got ${summary.results[0]?.elapsedMs})`,
        );
    }

    // ===== 8. CLI --help → exit 0 =====
    {
        const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
        const probePath = join(projectRoot, "probe-models.ts");
        const r = spawnSync(
            process.execPath,
            ["--import", "tsx", probePath, "--help"],
            { encoding: "utf8", timeout: 20_000 },
        );
        checkEqual(r.status, 0, "cli/help: exit 0");
        check(
            typeof r.stdout === "string" && r.stdout.includes("Usage:"),
            "cli/help: usage printed",
        );
    }

    // ===== 9. CLI with no key → exit 2 =====
    // Empty `GEMINI_API_KEY` / `GOOGLE_API_KEY` in the child's env are
    // sufficient to defeat any `.env` on disk: `dotenv` does not override
    // keys already present in `process.env`, even when the value is empty.
    // Cwd is left at its inherited value so `--import tsx` resolves from
    // the project's `node_modules` (tsx is resolved relative to cwd, and
    // the child would otherwise fail with ERR_MODULE_NOT_FOUND before the
    // CLI ever runs).
    {
        const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
        const probePath = join(projectRoot, "probe-models.ts");

        const env: NodeJS.ProcessEnv = { ...process.env };
        env.GEMINI_API_KEY = "";
        env.GOOGLE_API_KEY = "";

        const r = spawnSync(
            process.execPath,
            ["--import", "tsx", probePath],
            {
                encoding: "utf8",
                timeout: 20_000,
                env,
            },
        );
        checkEqual(r.status, 2, "cli/no-key: exit 2");
        check(
            typeof r.stderr === "string" && r.stderr.includes("GEMINI_API_KEY"),
            "cli/no-key: error mentions key",
        );
    }

    // ===== 10. Live probe against real API — manual only =====
    skip(
        "live: probe-models against the real API — run `npm run probe-models` manually",
    );
});