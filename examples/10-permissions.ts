/**
 * 10 — The two-lock permission model
 *
 * Every tool carries a permission tier: `read`, `mutate`, or
 * `dangerous`. The agent enforces a two-lock model:
 *
 *   - read      → always allowed
 *   - mutate    → requires a `confirmToolCall` callback that returns true
 *   - dangerous → requires BOTH `allowDangerous: true` AND a callback
 *                 returning true; the callback is not consulted if
 *                 `allowDangerous` is false
 *
 * This example drives the loop with a deterministic `ScriptedClient`
 * so you can see exactly what happens at each tier without spending
 * quota. Uses `ScriptedClient` because the point is the *mechanism*,
 * not the model.
 *
 *   npx tsx examples/10-permissions.ts
 */

import { z } from "zod";
import { Agent } from "../src/agent/agent.js";
import { FunctionTool } from "../src/agent/tools/base.js";
import {
    collectToolResults,
    loadEnv,
    printFinal,
    printTrace,
    section,
} from "./_common.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_fakes.js";

loadEnv();

function makeTools() {
    const readTool = new FunctionTool({
        name: "peek",
        description: "A read-only tool.",
        permission: "read",
        argsSchema: z.object({}),
        fn: () => "peeked",
    });
    const mutateTool = new FunctionTool({
        name: "toggle",
        description: "A state-changing tool.",
        permission: "mutate",
        argsSchema: z.object({}),
        fn: () => "toggled",
    });
    const dangerTool = new FunctionTool({
        name: "detonate",
        description: "A dangerous tool.",
        permission: "dangerous",
        argsSchema: z.object({}),
        fn: () => "detonated",
    });
    return [readTool, mutateTool, dangerTool];
}

function oneCallSequence() {
    return new ScriptedClient([
        toolCallResponse([makeToolCall("c1", "peek")]),
        toolCallResponse([makeToolCall("c2", "toggle")]),
        toolCallResponse([makeToolCall("c3", "detonate")]),
        textResponse("done"),
    ]);
}

async function runCase(
    label: string,
    options: { allowDangerous?: boolean; confirm?: () => boolean },
): Promise<void> {
    section(label);
    const client = oneCallSequence();
    const agent = new Agent({
        llmClient: client,
        tools: makeTools(),
        ...(options.allowDangerous !== undefined
            ? { allowDangerous: options.allowDangerous }
            : {}),
        ...(options.confirm !== undefined
            ? { confirmToolCall: async () => options.confirm!() }
            : {}),
    });
    const result = await agent.run("go");
    printTrace(result);
    const toolResults = collectToolResults(result);
    console.log("\n--- outcomes ---");
    for (const r of toolResults) {
        console.log(
            `  ${r.name.padEnd(10)} status=${r.status} kind=${r.errorKind ?? "null"}`,
        );
    }
}

async function main(): Promise<void> {
    // Case 1: no confirm callback, no allowDangerous.
    //   read  → runs
    //   mutate → denied (no callback)
    //   dangerous → denied (allowDangerous is false; callback not consulted)
    await runCase("case 1: no callback, allowDangerous=false", {});

    // Case 2: allowDangerous=true, but still no callback.
    //   dangerous → denied (callback is required even with allowDangerous)
    await runCase("case 2: allowDangerous=true, no callback", {
        allowDangerous: true,
    });

    // Case 3: confirm callback that always approves, allowDangerous=true.
    //   All three run.
    await runCase("case 3: callback approves, allowDangerous=true", {
        allowDangerous: true,
        confirm: () => true,
    });

    // Case 4: confirm callback that denies. Mutate and dangerous both
    // return error results with errorKind="denied", but the tool code
    // itself is never invoked.
    await runCase("case 4: callback denies", {
        allowDangerous: true,
        confirm: () => false,
    });

    section("in production");
    console.log(
        "The CLI exposes --approve (auto-yes) and --deny (auto-no) flags.",
    );
    console.log(
        "Interactive mode prompts you at the terminal; non-interactive mode",
    );
    console.log("defaults to deny so scripts never accidentally approve.");
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});