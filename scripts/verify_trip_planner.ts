import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { McpConnection } from "../src/agent/client.js";
import {
    MAX_DAYS,
    TripPlanSchema,
    runTripPlanner,
    type TripPlan,
} from "../src/workflows/trip-planner.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import {
    check,
    checkEqual,
    makeTempDir,
    runScript,
} from "./_verify-common.js";

function makeConnectionFactory(): (
    workspaceRoot: string,
) => Promise<McpConnection> {
    return async (workspaceRoot: string) => {
        const conn = new McpConnection("tsagent", {
            command: process.execPath,
            args: ["--import", "tsx", "src/agent/server.ts"],
            env: {
                WORKSPACE_ROOT: workspaceRoot,
                TAVILY_API_KEY: "",
            },
            connectTimeoutMs: 30_000,
        });
        await conn.connect();
        return conn;
    };
}

function makePlan(destination: string, days: number): TripPlan {
    const plan: TripPlan = {
        destination,
        summary: `A ${days}-day plan for ${destination}.`,
        days: [],
        tips: ["Pack comfortable shoes."],
    };
    for (let i = 1; i <= days; i += 1) {
        plan.days.push({
            day: i,
            title: `Day ${i} in ${destination}`,
            activities: [
                {
                    activity: `Explore ${destination} landmark #${i}`,
                    time: "morning",
                    notes: null,
                },
                {
                    activity: `Dinner at a local restaurant (day ${i})`,
                    time: "evening",
                    notes: null,
                },
            ],
        });
    }
    return plan;
}

runScript(async () => {
    const tmp = makeTempDir("trip-planner");
    try {
        // =====================================================================
        // 1. Happy path: 3-day plan
        // =====================================================================
        {
            const outputDir = join(tmp.path, "out-happy");
            const plan = makePlan("Tokyo", 3);

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "search_web", { query: "Tokyo travel 2026" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "final_answer", { output: plan }),
                ]),
            ]);

            const result = await runTripPlanner({
                destination: "Tokyo",
                days: 3,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 0, "happy: exit 0");
            checkEqual(result.destination, "Tokyo", "happy: destination preserved");
            checkEqual(result.requestedDays, 3, "happy: requestedDays");
            check(result.jsonPath !== null, "happy: jsonPath set");
            check(result.markdownPath !== null, "happy: markdownPath set");
            checkEqual(
                result.jsonPath,
                join(outputDir, "plan.json"),
                "happy: exact json path",
            );
            checkEqual(
                result.markdownPath,
                join(outputDir, "plan.md"),
                "happy: exact markdown path",
            );
            check(result.error === null, "happy: no error");
            check(result.plan !== null, "happy: plan present");
            checkEqual(result.plan?.days.length, 3, "happy: plan has 3 days");

            // JSON artifact round-trips.
            const jsonContent = readFileSync(result.jsonPath!, "utf8");
            const parsed = TripPlanSchema.safeParse(JSON.parse(jsonContent));
            check(parsed.success, "happy: json artifact matches schema");
            checkEqual(
                JSON.parse(jsonContent),
                plan,
                "happy: json artifact matches input plan",
            );

            // Markdown artifact contains expected markers.
            const mdContent = readFileSync(result.markdownPath!, "utf8");
            check(mdContent.includes("# Tokyo — 3-Day Plan"), "happy: md title");
            check(
                mdContent.includes("A 3-day plan for Tokyo."),
                "happy: md includes summary",
            );
            check(mdContent.includes("## Day 1: Day 1 in Tokyo"), "happy: day 1 heading");
            check(mdContent.includes("## Day 2: Day 2 in Tokyo"), "happy: day 2 heading");
            check(mdContent.includes("## Day 3: Day 3 in Tokyo"), "happy: day 3 heading");
            check(
                mdContent.includes("- **morning** — Explore Tokyo landmark #1"),
                "happy: activity with time rendered",
            );
            check(
                mdContent.includes("## Tips"),
                "happy: tips section present",
            );
            check(
                mdContent.includes("- Pack comfortable shoes."),
                "happy: tip rendered",
            );

            // Log written.
            const log = readFileSync(join(outputDir, "run.log.jsonl"), "utf8");
            check(log.length > 0, "happy: log written");
            check(log.includes("search_web"), "happy: log contains search_web");
        }

        // =====================================================================
        // 2. search_web never called → fail
        // =====================================================================
        {
            const outputDir = join(tmp.path, "out-no-search");
            const plan = makePlan("Paris", 2);
            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "final_answer", { output: plan }),
                ]),
            ]);

            const result = await runTripPlanner({
                destination: "Paris",
                days: 2,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 1, "no-search: exit 1");
            check(
                result.error?.includes("search_web was never called") ?? false,
                "no-search: error identifies missing search_web",
            );
        }

        // =====================================================================
        // 3. No structured output (maxSteps) → fail
        // =====================================================================
        {
            const outputDir = join(tmp.path, "out-maxsteps");
            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "search_web", { query: "x" }),
                ]),
            ]);

            const result = await runTripPlanner({
                destination: "Nowhere",
                days: 2,
                outputDir,
                llmClient: client,
                skipMemory: true,
                maxSteps: 1,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 1, "maxsteps: exit 1");
            check(
                result.error?.includes("maxSteps") ?? false,
                "maxsteps: error mentions maxSteps",
            );
        }

        // =====================================================================
        // 4. Wrong day count (fewer than requested) → fail
        // =====================================================================
        {
            const outputDir = join(tmp.path, "out-toofew");
            const plan = makePlan("Berlin", 2); // requested 3, plan has 2
            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "search_web", { query: "Berlin" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "final_answer", { output: plan }),
                ]),
            ]);

            const result = await runTripPlanner({
                destination: "Berlin",
                days: 3,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 1, "toofew: exit 1");
            check(
                result.error?.includes("2 days but 3 were requested") ?? false,
                "toofew: error mentions mismatched day count",
            );
        }

        // =====================================================================
        // 5. Wrong day numbering (out of order) → fail
        // =====================================================================
        {
            const outputDir = join(tmp.path, "out-order");
            const plan = makePlan("Rome", 3);
            // Break the numbering: swap days 1 and 2.
            plan.days[0]!.day = 2;
            plan.days[1]!.day = 1;

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "search_web", { query: "Rome" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "final_answer", { output: plan }),
                ]),
            ]);

            const result = await runTripPlanner({
                destination: "Rome",
                days: 3,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 1, "order: exit 1");
            check(
                result.error?.includes("expected 1") ?? false,
                "order: error mentions expected day number",
            );
        }

        // =====================================================================
        // 6. Missing destination → exit 2
        // =====================================================================
        {
            const result = await runTripPlanner({
                destination: "   ",
                days: 3,
                llmClient: new ScriptedClient([]),
                skipMemory: true,
            });
            checkEqual(result.exitCode, 2, "empty-dest: exit 2");
            check(
                result.error?.includes("destination is empty") ?? false,
                "empty-dest: error mentions empty destination",
            );
        }

        // =====================================================================
        // 7. days = 0 → exit 2
        // =====================================================================
        {
            const result = await runTripPlanner({
                destination: "Anywhere",
                days: 0,
                llmClient: new ScriptedClient([]),
                skipMemory: true,
            });
            checkEqual(result.exitCode, 2, "days-zero: exit 2");
            check(
                result.error?.includes("days must be") ?? false,
                "days-zero: error mentions days constraint",
            );
        }

        // =====================================================================
        // 8. days > MAX_DAYS → exit 2
        // =====================================================================
        {
            const result = await runTripPlanner({
                destination: "Anywhere",
                days: MAX_DAYS + 1,
                llmClient: new ScriptedClient([]),
                skipMemory: true,
            });
            checkEqual(result.exitCode, 2, "days-toomany: exit 2");
            check(
                result.error?.includes(`[1, ${MAX_DAYS}]`) ?? false,
                "days-toomany: error mentions MAX_DAYS bound",
            );
        }

        // =====================================================================
        // 9. Non-integer days → exit 2
        // =====================================================================
        {
            const result = await runTripPlanner({
                destination: "Anywhere",
                days: 2.5,
                llmClient: new ScriptedClient([]),
                skipMemory: true,
            });
            checkEqual(result.exitCode, 2, "days-nonint: exit 2");
        }

        // =====================================================================
        // 10. Prompt instructions include required tool and day count
        // =====================================================================
        {
            const outputDir = join(tmp.path, "out-prompt");
            const plan = makePlan("Lisbon", 4);
            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "search_web", { query: "x" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "final_answer", { output: plan }),
                ]),
            ]);

            await runTripPlanner({
                destination: "Lisbon",
                days: 4,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            const firstCall = client.calls[0];
            const instructions = (firstCall?.instructions ?? []).join("\n");
            check(instructions.includes("search_web"), "prompt: mentions search_web");
            check(instructions.includes("EXACTLY 4"), "prompt: mentions exact day count");
            check(instructions.includes("Lisbon"), "prompt: mentions destination");
            checkEqual(
                firstCall?.toolChoice,
                "required",
                "prompt: toolChoice is required (structured output)",
            );
        }

        // =====================================================================
        // 11. MCP spawn failure → exit 1 with clean error
        // =====================================================================
        {
            const outputDir = join(tmp.path, "out-spawn");
            const originalCommand = process.env.MCP_SERVER_COMMAND;
            process.env.MCP_SERVER_COMMAND = "/nonexistent-tsagent-trip-planner";
            try {
                const result = await runTripPlanner({
                    destination: "Nowhere",
                    days: 1,
                    outputDir,
                    llmClient: new ScriptedClient([]),
                    skipMemory: true,
                });
                checkEqual(result.exitCode, 1, "spawn: exit 1");
                check(
                    result.error?.includes("MCP server failed to start") ?? false,
                    "spawn: error mentions MCP",
                );
            } finally {
                if (originalCommand === undefined) {
                    delete process.env.MCP_SERVER_COMMAND;
                } else {
                    process.env.MCP_SERVER_COMMAND = originalCommand;
                }
            }
        }

        // =====================================================================
        // 12. keepOnFailure preserves the output dir on failure
        // =====================================================================
        {
            const outputDir = join(tmp.path, "out-keep");
            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "search_web", { query: "x" }),
                ]),
            ]);

            const result = await runTripPlanner({
                destination: "Nowhere",
                days: 2,
                outputDir,
                llmClient: client,
                skipMemory: true,
                maxSteps: 1,
                keepOnFailure: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 1, "keep: exit 1");
            let logExists = true;
            try {
                readFileSync(join(outputDir, "run.log.jsonl"));
            } catch {
                logExists = false;
            }
            check(logExists, "keep: output dir preserved");
        }

        // =====================================================================
        // 13. Quota exhausted → exit 3
        // =====================================================================
        {
            const outputDir = join(tmp.path, "out-quota");
            const client = new ScriptedClient([
                {
                    text: null,
                    toolCalls: [],
                    usage: null,
                    providerOptions: {},
                    errorMessage: "quota exceeded",
                    errorMetadata: {
                        errorType: "quota",
                        quotaExhausted: true,
                        statusCode: 429,
                    },
                },
            ]);

            const result = await runTripPlanner({
                destination: "Nowhere",
                days: 1,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 3, "quota: exit 3");
        }

        // =====================================================================
        // 14. CLI parse: --approve --deny conflict → exit 2
        // =====================================================================
        {
            const { spawnSync } = await import("node:child_process");
            const mainTsPath = join(
                process.cwd(),
                "src",
                "workflows",
                "trip-planner.ts",
            );

            const conflict = spawnSync(
                process.execPath,
                [
                    "--import",
                    "tsx",
                    mainTsPath,
                    "Tokyo",
                    "--days",
                    "3",
                    "--approve",
                    "--deny",
                ],
                { encoding: "utf8", timeout: 20_000 },
            );
            checkEqual(conflict.status, 2, "cli/conflict: exit 2");
            check(
                typeof conflict.stderr === "string" &&
                conflict.stderr.includes("mutually exclusive"),
                "cli/conflict: message",
            );

            const missingDays = spawnSync(
                process.execPath,
                ["--import", "tsx", mainTsPath, "Tokyo"],
                { encoding: "utf8", timeout: 20_000 },
            );
            checkEqual(missingDays.status, 2, "cli/missing-days: exit 2");

            const missingDest = spawnSync(
                process.execPath,
                ["--import", "tsx", mainTsPath, "--days", "3"],
                { encoding: "utf8", timeout: 20_000 },
            );
            checkEqual(missingDest.status, 2, "cli/missing-dest: exit 2");
        }

        // =====================================================================
        // 15. Optional fields (time/notes/tips) are honored in rendering
        // =====================================================================
        {
            const outputDir = join(tmp.path, "out-optional");
            const plan: TripPlan = {
                destination: "Amsterdam",
                summary: "A short trip.",
                days: [
                    {
                        day: 1,
                        title: "Arrival",
                        activities: [
                            { activity: "Check in", time: null, notes: "Drop bags early." },
                            { activity: "Walk the canals", time: "afternoon", notes: null },
                        ],
                    },
                ],
                tips: [],
            };

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "search_web", { query: "Amsterdam" }),
                ]),
                toolCallResponse([
                    makeToolCall("c2", "final_answer", { output: plan }),
                ]),
            ]);

            const result = await runTripPlanner({
                destination: "Amsterdam",
                days: 1,
                outputDir,
                llmClient: client,
                skipMemory: true,
                confirmToolCall: () => true,
                connectionFactory: makeConnectionFactory(),
            });

            checkEqual(result.exitCode, 0, "optional: exit 0");
            const md = readFileSync(result.markdownPath!, "utf8");
            // No time → plain bullet.
            check(md.includes("- Check in"), "optional: no-time activity rendered as bullet");
            check(
                md.includes("  Drop bags early."),
                "optional: notes indented under activity",
            );
            // With time → bold time.
            check(
                md.includes("- **afternoon** — Walk the canals"),
                "optional: with-time activity rendered bolded",
            );
            // No tips → no tips section.
            check(!md.includes("## Tips"), "optional: empty tips section omitted");
        }

        // =====================================================================
        // 16. Memory round-trip: summary stored under slug
        // =====================================================================
        {
            const { MemoryStore } = await import("../src/agent/memory.js");
            const { slugify } = await import("../src/workflows/_shared.js");
            const memoryPath = join(tmp.path, "memory.sqlite3");
            const memory = new MemoryStore(memoryPath);
            try {
                const outputDir = join(tmp.path, "out-memory");
                const plan = makePlan("Kyoto", 2);
                const client = new ScriptedClient([
                    toolCallResponse([
                        makeToolCall("c1", "search_web", { query: "Kyoto" }),
                    ]),
                    toolCallResponse([
                        makeToolCall("c2", "final_answer", { output: plan }),
                    ]),
                ]);

                const result = await runTripPlanner({
                    destination: "Kyoto",
                    days: 2,
                    outputDir,
                    llmClient: client,
                    memoryStore: memory,
                    confirmToolCall: () => true,
                    connectionFactory: makeConnectionFactory(),
                });

                checkEqual(result.exitCode, 0, "memory: exit 0");
                const stored = memory.list("trip-plans");
                check(
                    stored.some((r) => r.key === slugify("Kyoto")),
                    "memory: summary stored under slug",
                );
                const row = stored.find((r) => r.key === slugify("Kyoto"));
                checkEqual(
                    row?.content,
                    plan.summary,
                    "memory: stored content matches plan summary",
                );
            } finally {
                memory.close();
            }
        }

        // =====================================================================
        // 17. Schema validates a well-formed input directly
        // =====================================================================
        {
            const plan = makePlan("Oslo", 2);
            const parsed = TripPlanSchema.safeParse(plan);
            check(parsed.success, "schema: valid plan parses");
            const invalid = TripPlanSchema.safeParse({
                destination: "X",
                summary: "S",
                days: [], // min(1) violated
            });
            check(!invalid.success, "schema: empty days rejected");
            void mkdirSync;
        }
    } finally {
        try {
            rmSync(tmp.path, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }
});