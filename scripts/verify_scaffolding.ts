import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    check,
    checkEqual,
    checkSoft,
    makeTempDir,
    runScript,
} from "./_verify-common.js";

runScript(async () => {
    console.log(`Project root: ${resolve(".")}\n`);

    // ----- package.json -----
    const pkgPath = resolve("package.json");
    check(existsSync(pkgPath), "package.json exists");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        type?: string;
        engines?: { node?: string };
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
    };
    checkEqual(pkg.type, "module", 'package.json: "type": "module"');
    check(pkg.engines?.node !== undefined, "package.json: engines.node is declared");
    check(pkg.scripts?.typecheck !== undefined, "package.json: typecheck script is declared");

    const requiredDeps = [
        "zod",
        "ai",
        "@ai-sdk/google",
        "@modelcontextprotocol/sdk",
        "better-sqlite3",
        "commander",
        "dotenv",
        "zod-to-json-schema",
        "@opentelemetry/api",
        "@opentelemetry/sdk-trace-node",
        "@opentelemetry/exporter-trace-otlp-http",
    ];
    for (const dep of requiredDeps) {
        checkSoft(
            pkg.dependencies?.[dep] !== undefined,
            `package.json declares dependency: ${dep}`,
        );
    }

    const requiredDevDeps = [
        "typescript",
        "tsx",
        "@types/node",
        "@types/better-sqlite3",
    ];
    for (const dep of requiredDevDeps) {
        checkSoft(
            pkg.devDependencies?.[dep] !== undefined,
            `package.json declares devDependency: ${dep}`,
        );
    }

    // ----- tsconfig.json -----
    const tsconfigPath = resolve("tsconfig.json");
    check(existsSync(tsconfigPath), "tsconfig.json exists");
    const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as {
        compilerOptions?: Record<string, unknown>;
    };
    checkEqual(tsconfig.compilerOptions?.strict, true, "tsconfig: strict is true");
    checkEqual(
        tsconfig.compilerOptions?.noUncheckedIndexedAccess,
        true,
        "tsconfig: noUncheckedIndexedAccess is true",
    );
    checkEqual(
        tsconfig.compilerOptions?.exactOptionalPropertyTypes,
        true,
        "tsconfig: exactOptionalPropertyTypes is true",
    );

    // ----- node_modules: every declared runtime dep is installed -----
    for (const dep of requiredDeps) {
        const marker = resolve("node_modules", dep, "package.json");
        checkSoft(existsSync(marker), `dependency installed: ${dep}`);
    }

    // ----- key runtime imports -----
    try {
        const { z } = await import("zod");
        check(typeof z.object === "function", "zod imports and z.object is a function");
    } catch (error) {
        checkSoft(false, `zod import failed: ${(error as Error).message}`);
    }

    // ----- our source modules export the expected symbols -----
    const schemas = await import("../src/agent/schemas.js");
    check(schemas.AgentEventSchema !== undefined, "schemas exports AgentEventSchema");
    check(schemas.ContentItemSchema !== undefined, "schemas exports ContentItemSchema");
    check(schemas.MessageSchema !== undefined, "schemas exports MessageSchema");
    check(schemas.ToolCallSchema !== undefined, "schemas exports ToolCallSchema");
    check(schemas.ToolResultSchema !== undefined, "schemas exports ToolResultSchema");
    check(
        schemas.MultipartContentSchema !== undefined,
        "schemas exports MultipartContentSchema",
    );
    check(typeof schemas.makeEvent === "function", "schemas exports makeEvent");

    const context = await import("../src/agent/context.js");
    check(typeof context.ExecutionContext === "function", "context exports ExecutionContext");
    check(typeof context.deriveStep === "function", "context exports deriveStep");
    check(
        typeof context.deriveFinalResult === "function",
        "context exports deriveFinalResult",
    );

    const eventLog = await import("../src/agent/event-log.js");
    check(typeof eventLog.JsonlEventLog === "function", "event-log exports JsonlEventLog");
    check(typeof eventLog.NullEventLog === "function", "event-log exports NullEventLog");
    check(typeof eventLog.readEventLog === "function", "event-log exports readEventLog");
    check(typeof eventLog.iterEventLog === "function", "event-log exports iterEventLog");
    check(
        typeof eventLog.EventLogFormatError === "function",
        "event-log exports EventLogFormatError",
    );

    // ----- .env.example -----
    const envExamplePath = resolve(".env.example");
    check(existsSync(envExamplePath), ".env.example exists");
    const envContent = readFileSync(envExamplePath, "utf8");
    const envLines = envContent
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    for (const line of envLines) {
        checkSoft(line.includes("="), `.env.example line is KEY=VALUE: ${line}`);
    }

    // ----- makeTempDir sanity -----
    const tmp = makeTempDir("scaffolding");
    try {
        check(existsSync(tmp.path), "makeTempDir creates a directory");
    } finally {
        tmp.cleanup();
    }
    check(!existsSync(tmp.path), "makeTempDir cleanup removes the directory");
});