import { z, ZodError } from "zod";
import {
    BaseTool,
    FunctionTool,
    RemoteTool,
    ToolError,
    isPermissionTier,
} from "../src/agent/tools/base.js";
import { addTool } from "../src/agent/tools/add.js";
import { greetTool } from "../src/agent/tools/greet.js";
import { calculatorTool, evaluateExpression } from "../src/agent/tools/calculator.js";
import {
    textPart,
    imagePart,
    resourcePart,
    structuredPart,
    multipart,
} from "../src/agent/tools/multipart.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(async () => {
    // ===== ToolError =====
    const err = new ToolError("boom");
    check(err instanceof Error, "ToolError is an Error subclass");
    checkEqual(err.name, "ToolError", "ToolError name");
    checkEqual(err.message, "boom", "ToolError message");

    // ===== Permission tier validation =====
    check(isPermissionTier("read"), "isPermissionTier: read");
    check(isPermissionTier("mutate"), "isPermissionTier: mutate");
    check(isPermissionTier("dangerous"), "isPermissionTier: dangerous");
    check(!isPermissionTier("admin"), "isPermissionTier: admin rejected");
    check(!isPermissionTier(""), "isPermissionTier: empty rejected");

    // ===== Default permission / concurrencySafe derivation =====
    const readTool = new FunctionTool({
        name: "read_tool",
        description: "a read tool",
        argsSchema: z.object({}),
        fn: () => "ok",
    });
    checkEqual(readTool.permission, "read", "default permission is read");
    checkEqual(readTool.concurrencySafe, true, "read tool defaults concurrencySafe true");
    checkEqual(readTool.timeoutMs, null, "default timeoutMs is null");

    const mutateTool = new FunctionTool({
        name: "mutate_tool",
        description: "a mutate tool",
        permission: "mutate",
        argsSchema: z.object({}),
        fn: () => "ok",
    });
    checkEqual(mutateTool.permission, "mutate", "explicit permission mutate");
    checkEqual(
        mutateTool.concurrencySafe,
        false,
        "mutate tool defaults concurrencySafe false",
    );

    const dangerousTool = new FunctionTool({
        name: "dangerous_tool",
        description: "a dangerous tool",
        permission: "dangerous",
        argsSchema: z.object({}),
        fn: () => "ok",
    });
    checkEqual(dangerousTool.permission, "dangerous", "explicit permission dangerous");
    checkEqual(
        dangerousTool.concurrencySafe,
        false,
        "dangerous tool defaults concurrencySafe false",
    );

    const safeMutate = new FunctionTool({
        name: "safe_mutate",
        description: "mutate but concurrency-safe",
        permission: "mutate",
        concurrencySafe: true,
        argsSchema: z.object({}),
        fn: () => "ok",
    });
    checkEqual(
        safeMutate.concurrencySafe,
        true,
        "explicit concurrencySafe override works",
    );

    // ===== Validation of constructor inputs =====
    let invalidPermissionRejected = false;
    try {
        new FunctionTool({
            name: "x",
            description: "x",
            // @ts-expect-error - testing invalid permission at runtime
            permission: "admin",
            argsSchema: z.object({}),
            fn: () => "ok",
        });
    } catch {
        invalidPermissionRejected = true;
    }
    check(invalidPermissionRejected, "invalid permission tier rejected");

    let emptyNameRejected = false;
    try {
        new FunctionTool({
            name: "",
            description: "x",
            argsSchema: z.object({}),
            fn: () => "ok",
        });
    } catch {
        emptyNameRejected = true;
    }
    check(emptyNameRejected, "empty tool name rejected");

    let invalidTimeoutRejected = false;
    try {
        new FunctionTool({
            name: "x",
            description: "x",
            timeoutMs: -1,
            argsSchema: z.object({}),
            fn: () => "ok",
        });
    } catch {
        invalidTimeoutRejected = true;
    }
    check(invalidTimeoutRejected, "negative timeoutMs rejected");

    const timeoutTool = new FunctionTool({
        name: "timeout_tool",
        description: "x",
        timeoutMs: 5000,
        argsSchema: z.object({}),
        fn: () => "ok",
    });
    checkEqual(timeoutTool.timeoutMs, 5000, "timeoutMs stored on instance");

    // ===== toolDefinition shape (add) =====
    const addDef = addTool.toolDefinition();
    checkEqual(addDef.type, "function", "toolDefinition: type is 'function'");
    checkEqual(addDef.function.name, "add", "toolDefinition: function.name");
    check(
        addDef.function.description.length > 0,
        "toolDefinition: function.description non-empty",
    );
    checkEqual(
        addDef.function.parameters.type,
        "object",
        "toolDefinition: parameters.type is 'object'",
    );
    const props = addDef.function.parameters.properties as Record<string, unknown>;
    check("a" in props, "toolDefinition: parameters.properties.a exists");
    check("b" in props, "toolDefinition: parameters.properties.b exists");
    const required = addDef.function.parameters.required as string[];
    check(required.includes("a"), "toolDefinition: 'a' is required");
    check(required.includes("b"), "toolDefinition: 'b' is required");
    check(!("$schema" in addDef.function.parameters), "toolDefinition: $schema stripped");
    check(!("title" in addDef.function.parameters), "toolDefinition: title stripped");

    // ===== add tool =====
    checkEqual(await addTool.run({ a: 2, b: 3 }), [5], "add: 2 + 3 = [5]");
    checkEqual(await addTool.run({ a: -1, b: 1 }), [0], "add: -1 + 1 = [0]");
    checkEqual(await addTool.run({ a: 0.5, b: 0.25 }), [0.75], "add: 0.5 + 0.25 = [0.75]");

    let addMissingRejected = false;
    try {
        await addTool.run({ a: 2 });
    } catch (error) {
        addMissingRejected = error instanceof ZodError;
    }
    check(addMissingRejected, "add: missing 'b' throws ZodError");

    let addWrongTypeRejected = false;
    try {
        await addTool.run({ a: "x", b: 3 });
    } catch (error) {
        addWrongTypeRejected = error instanceof ZodError;
    }
    check(addWrongTypeRejected, "add: string 'a' throws ZodError");

    // ===== greet tool =====
    checkEqual(await greetTool.run({ name: "Alice" }), ["Hello, Alice!"], "greet: Alice");
    checkEqual(
        await greetTool.run({ name: "" }),
        ["Hello, !"],
        "greet: empty name produces 'Hello, !'",
    );

    // ===== empty-schema tool definition =====
    const emptySchemaTool = new FunctionTool({
        name: "empty",
        description: "no args",
        argsSchema: z.object({}),
        fn: () => "ok",
    });
    const emptyDef = emptySchemaTool.toolDefinition();
    checkEqual(
        emptyDef.function.parameters.type,
        "object",
        "empty schema: parameters.type is 'object'",
    );
    const emptyProps = (emptyDef.function.parameters.properties ?? {}) as Record<
        string,
        unknown
    >;
    checkEqual(emptyProps, {}, "empty schema: properties is empty");

    // ===== calculator: successful cases =====
    const calcCases: Array<[string, number]> = [
        ["2 + 3", 5],
        ["2 - 3", -1],
        ["2 * 3", 6],
        ["10 / 4", 2.5],
        ["10 // 4", 2],
        ["10 % 3", 1],
        ["2 ** 10", 1024],
        ["(2 + 3) * 4", 20],
        ["2 + 3 * 4", 14],
        ["2 ** 3 ** 2", 512],
        ["-2 ** 2", -4],
        ["2 ** -2", 0.25],
        ["-7 // 2", -4],
        ["-7 % 2", 1],
        ["  2 + 3  ", 5],
        ["3.5 * 2", 7],
        ["1e3", 1000],
        ["1e-3", 0.001],
        ["1_000", 1000],
        ["1_000.5", 1000.5],
    ];
    for (const [expr, expected] of calcCases) {
        checkEqual(evaluateExpression(expr), expected, `calculator: ${expr} = ${expected}`);
    }

    // ===== calculator: error cases =====
    const calcErrors = [
        "1 / 0",
        "1 // 0",
        "1 % 0",
        "__import__('os')",
        "x + 1",
        "foo.bar",
        "2 ** 101",
        "2 +",
        "(2 + 3",
        "2 3",
        "",
        "2 $ 3",
        "1__0",
        "_1",
        "1_",
    ];
    for (const expr of calcErrors) {
        let threw = false;
        try {
            evaluateExpression(expr);
        } catch (error) {
            threw = error instanceof ToolError;
        }
        check(threw, `calculator: ${JSON.stringify(expr)} throws ToolError`);
    }

    // ===== calculator via FunctionTool =====
    checkEqual(
        await calculatorTool.run({ expression: "2 + 3" }),
        [5],
        "calculatorTool: 2 + 3 = [5]",
    );

    let calcDivZero = false;
    try {
        await calculatorTool.run({ expression: "1 / 0" });
    } catch (error) {
        calcDivZero = error instanceof ToolError;
    }
    check(calcDivZero, "calculatorTool: 1/0 throws ToolError");

    let calcEmptyRejected = false;
    try {
        await calculatorTool.run({ expression: "" });
    } catch (error) {
        calcEmptyRejected = error instanceof ZodError;
    }
    check(calcEmptyRejected, "calculatorTool: empty expression throws ZodError");

    // ===== async function tool =====
    const asyncTool = new FunctionTool({
        name: "async_tool",
        description: "async test",
        argsSchema: z.object({ x: z.number() }),
        fn: async ({ x }) => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return x * 2;
        },
    });
    checkEqual(await asyncTool.run({ x: 21 }), [42], "async function tool: 21 * 2 = [42]");

    // ===== array return preserved =====
    const arrayTool = new FunctionTool({
        name: "array_tool",
        description: "returns an array",
        argsSchema: z.object({}),
        fn: () => ["a", "b", "c"],
    });
    checkEqual(
        await arrayTool.run({}),
        ["a", "b", "c"],
        "array return is preserved as-is",
    );

    // ===== object return wrapped =====
    const objectTool = new FunctionTool({
        name: "object_tool",
        description: "returns an object",
        argsSchema: z.object({}),
        fn: () => ({ x: 1, y: 2 }),
    });
    checkEqual(
        await objectTool.run({}),
        [{ x: 1, y: 2 }],
        "object return is wrapped in a single-element array",
    );

    // ===== multipart return preserved =====
    const multipartTool = new FunctionTool({
        name: "multipart_tool",
        description: "returns multipart",
        argsSchema: z.object({}),
        fn: () => multipart([textPart("hello")]),
    });
    const mpResult = await multipartTool.run({});
    checkEqual(mpResult.length, 1, "multipart return: array of length 1");
    const mp = mpResult[0] as { type: string; parts: unknown[] };
    checkEqual(mp.type, "multipart", "multipart return: type is 'multipart'");
    checkEqual(mp.parts.length, 1, "multipart return: one part");

    // ===== RemoteTool =====
    const remoteCalls: Array<Record<string, unknown>> = [];
    const remoteSchema = {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
    };
    const remoteTool = new RemoteTool({
        name: "remote_tool",
        description: "a remote tool",
        inputSchema: remoteSchema,
        callTool: async (args) => {
            remoteCalls.push(args);
            return [`result for ${args.query as string}`];
        },
    });
    checkEqual(remoteTool.permission, "read", "RemoteTool: default permission read");
    checkEqual(
        remoteTool.concurrencySafe,
        true,
        "RemoteTool: read defaults concurrencySafe true",
    );
    const remoteDef = remoteTool.toolDefinition();
    checkEqual(
        remoteDef.function.parameters,
        remoteSchema,
        "RemoteTool: uses inputSchema verbatim",
    );
    const remoteResult = await remoteTool.run({ query: "test" });
    checkEqual(remoteResult, ["result for test"], "RemoteTool: delegates to callTool");
    checkEqual(remoteCalls.length, 1, "RemoteTool: callTool called exactly once");
    checkEqual(remoteCalls[0], { query: "test" }, "RemoteTool: arguments passed through");

    const remoteMutate = new RemoteTool({
        name: "remote_mutate",
        description: "x",
        permission: "mutate",
        inputSchema: { type: "object", properties: {} },
        callTool: async () => [],
    });
    checkEqual(
        remoteMutate.concurrencySafe,
        false,
        "RemoteTool mutate defaults concurrencySafe false",
    );

    const remoteTimed = new RemoteTool({
        name: "remote_timed",
        description: "x",
        inputSchema: { type: "object", properties: {} },
        timeoutMs: 3000,
        callTool: async () => [],
    });
    checkEqual(remoteTimed.timeoutMs, 3000, "RemoteTool timeoutMs stored");

    // ===== Multipart helpers =====
    const tp = textPart("hi");
    checkEqual(tp.type, "text", "textPart: type");
    checkEqual((tp as { text: string }).text, "hi", "textPart: text");

    const ip = imagePart("image/png", "base64");
    checkEqual(ip.type, "image", "imagePart: type");
    checkEqual((ip as { mimeType: string }).mimeType, "image/png", "imagePart: mimeType");
    checkEqual((ip as { data: string }).data, "base64", "imagePart: data");

    const rp1 = resourcePart({ uri: "file:///x", text: "body" });
    checkEqual(rp1.type, "resource", "resourcePart: type");
    checkEqual((rp1 as { uri: string }).uri, "file:///x", "resourcePart: uri");
    checkEqual((rp1 as { text: string | null }).text, "body", "resourcePart: text");
    checkEqual(
        (rp1 as { mimeType: string | null }).mimeType,
        null,
        "resourcePart: mimeType defaults null",
    );

    const rp2 = resourcePart({ uri: "file:///y", mimeType: "text/plain" });
    checkEqual(
        (rp2 as { mimeType: string | null }).mimeType,
        "text/plain",
        "resourcePart: mimeType set",
    );
    checkEqual((rp2 as { text: string | null }).text, null, "resourcePart: text defaults null");
    checkEqual((rp2 as { blob: string | null }).blob, null, "resourcePart: blob defaults null");

    const sp = structuredPart({ a: 1, b: [2, 3] });
    checkEqual(sp.type, "structured", "structuredPart: type");
    checkEqual(
        (sp as { data: unknown }).data,
        { a: 1, b: [2, 3] },
        "structuredPart: data",
    );

    const mpAll = multipart([tp, ip, rp1, sp]);
    checkEqual(mpAll.type, "multipart", "multipart: type");
    checkEqual(mpAll.parts.length, 4, "multipart: 4 parts");

    // ===== Custom BaseTool subclass =====
    class CustomTool extends BaseTool {
        constructor() {
            super({ name: "custom", description: "custom tool" });
        }
        toolDefinition() {
            return {
                type: "function" as const,
                function: {
                    name: this.name,
                    description: this.description,
                    parameters: { type: "object", properties: {} },
                },
            };
        }
        async run(): Promise<unknown[]> {
            return ["custom result"];
        }
    }
    const custom = new CustomTool();
    checkEqual(custom.name, "custom", "CustomTool: name");
    checkEqual(custom.description, "custom tool", "CustomTool: description");
    checkEqual(custom.permission, "read", "CustomTool: default permission");
    checkEqual(await custom.run(), ["custom result"], "CustomTool: run returns array");
});