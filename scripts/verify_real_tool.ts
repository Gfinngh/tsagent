import { Agent } from "../src/agent/agent.js";
import { McpConnection, loadMcpTools } from "../src/agent/client.js";
import {
    ScriptedClient,
    makeToolCall,
    textResponse,
    toolCallResponse,
} from "./_verify-agent.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(async () => {
    const connection = new McpConnection("tsagent", {
        command: process.execPath,
        args: ["--import", "tsx", "src/agent/server.ts"],
        connectTimeoutMs: 30_000,
    });

    try {
        await connection.connect();

        // ----- loadMcpTools: default overrides -----
        {
            const tools = await loadMcpTools(connection);
            check(tools.length >= 2, `loadMcpTools: at least 2 tools (got ${tools.length})`);
            const calculator = tools.find((t) => t.name === "calculator");
            const greet = tools.find((t) => t.name === "greet");
            check(calculator !== undefined, "loadMcpTools: calculator present");
            check(greet !== undefined, "loadMcpTools: greet present");
            checkEqual(calculator?.permission, "read", "loadMcpTools: calculator default read");
            checkEqual(calculator?.concurrencySafe, true, "loadMcpTools: calculator safe");
            checkEqual(greet?.permission, "read", "loadMcpTools: greet default read");

            // Tool definition shape
            const def = calculator?.toolDefinition();
            checkEqual(def?.type, "function", "loadMcpTools: definition type");
            checkEqual(def?.function.name, "calculator", "loadMcpTools: definition name");
            check(typeof def?.function.description === "string", "loadMcpTools: description present");
            check(def?.function.parameters !== undefined, "loadMcpTools: parameters present");
        }

        // ----- loadMcpTools: server-advertised permissions -----
        //
        // Regression coverage for the bug where `loadMcpTools` ignored the
        // server's declared permission tier, so `write_file` was silently
        // downgraded to `read` and the `--deny` flag had nothing to deny.
        {
            const tools = await loadMcpTools(connection);
            const byName = new Map(tools.map((t) => [t.name, t]));

            checkEqual(
                byName.get("write_file")?.permission,
                "mutate",
                "server-meta: write_file is mutate",
            );
            checkEqual(
                byName.get("write_file")?.concurrencySafe,
                false,
                "server-meta: write_file not concurrency-safe",
            );
            checkEqual(
                byName.get("execute_python")?.permission,
                "dangerous",
                "server-meta: execute_python is dangerous",
            );
            checkEqual(
                byName.get("execute_python")?.concurrencySafe,
                false,
                "server-meta: execute_python not concurrency-safe",
            );

            // Read tools stay read.
            checkEqual(byName.get("calculator")?.permission, "read", "server-meta: calculator read");
            checkEqual(byName.get("greet")?.permission, "read", "server-meta: greet read");
            checkEqual(byName.get("list_files")?.permission, "read", "server-meta: list_files read");
            checkEqual(byName.get("read_file")?.permission, "read", "server-meta: read_file read");
            checkEqual(byName.get("search_web")?.permission, "read", "server-meta: search_web read");
        }

        // ----- loadMcpTools: explicit overrides still win over server meta -----
        {
            const tools = await loadMcpTools(connection, {
                write_file: { permission: "dangerous" },
                calculator: { permission: "mutate", timeoutMs: 5000 },
                greet: { description: "custom greeting" },
            });
            const byName = new Map(tools.map((t) => [t.name, t]));
            checkEqual(
                byName.get("write_file")?.permission,
                "dangerous",
                "overrides: explicit overrides beat server meta",
            );
            checkEqual(byName.get("calculator")?.permission, "mutate", "overrides: calculator mutate");
            checkEqual(byName.get("calculator")?.timeoutMs, 5000, "overrides: calculator timeoutMs");
            checkEqual(
                byName.get("calculator")?.concurrencySafe,
                false,
                "overrides: mutate defaults to not concurrency-safe",
            );
            checkEqual(
                byName.get("greet")?.description,
                "custom greeting",
                "overrides: greet description",
            );
            checkEqual(byName.get("greet")?.permission, "read", "overrides: greet still read");
        }

        // ----- End-to-end: Agent drives MCP tool -----
        {
            const tools = await loadMcpTools(connection);
            const client = new ScriptedClient([
                toolCallResponse([makeToolCall("c1", "calculator", { expression: "2 + 3" })]),
                textResponse("The result is 5."),
            ]);
            const agent = new Agent({ llmClient: client, tools });
            const result = await agent.run("What is 2+3?");

            checkEqual(result.context.currentStep, 2, "e2e: two steps");
            checkEqual(result.finalResult?.kind, "text", "e2e: text final result");
            if (result.finalResult?.kind === "text") {
                checkEqual(result.finalResult.text, "The result is 5.", "e2e: final text");
            }

            const toolResultItem = result.context.events
                .flatMap((e) => e.content)
                .find((c) => c.type === "tool_result");
            check(toolResultItem !== undefined, "e2e: tool_result event present");
            if (toolResultItem?.type === "tool_result") {
                checkEqual(toolResultItem.toolResult.status, "success", "e2e: status success");
                checkEqual(toolResultItem.toolResult.toolCallId, "c1", "e2e: toolCallId preserved");
            }

            const secondCall = client.calls[1];
            check(secondCall !== undefined, "e2e: second LLM call captured");
            const toolResultInSecondRequest = secondCall?.events
                .flatMap((e) => e.content)
                .find((c) => c.type === "tool_result");
            check(
                toolResultInSecondRequest !== undefined,
                "e2e: second request includes tool_result event",
            );
        }

        // ----- Permission denial on MCP mutate tool (via explicit override) -----
        {
            const tools = await loadMcpTools(connection, {
                calculator: { permission: "mutate" },
            });
            const client = new ScriptedClient([
                toolCallResponse([makeToolCall("c1", "calculator", { expression: "2 + 3" })]),
                textResponse("ok"),
            ]);
            const agent = new Agent({
                llmClient: client,
                tools,
                // no confirmToolCall → mutate denied
            });
            const result = await agent.run("go");

            const toolResultItem = result.context.events
                .flatMap((e) => e.content)
                .find((c) => c.type === "tool_result");
            if (toolResultItem?.type === "tool_result") {
                checkEqual(
                    toolResultItem.toolResult.status,
                    "error",
                    "permissions: denied call is error",
                );
                check(
                    String(toolResultItem.toolResult.content[0]).includes("confirmation"),
                    "permissions: reason mentions confirmation",
                );
            } else {
                check(false, "permissions: tool_result event present");
            }
        }

        // ----- Permission denial via server meta (write_file), no override -----
        //
        // The CLI scenario: no overrides, but the server says write_file is
        // mutate. With no confirm callback, it must be denied.
        {
            const tools = await loadMcpTools(connection);
            const writeFile = tools.find((t) => t.name === "write_file");
            check(writeFile !== undefined, "meta-deny: write_file present");
            checkEqual(writeFile?.permission, "mutate", "meta-deny: write_file is mutate");

            const client = new ScriptedClient([
                toolCallResponse([
                    makeToolCall("c1", "write_file", {
                        path: "meta-deny-test.txt",
                        content: "should not exist",
                    }),
                ]),
                textResponse("ok"),
            ]);
            const agent = new Agent({
                llmClient: client,
                tools,
                // no confirmToolCall → mutate denied
            });
            const result = await agent.run("go");

            const toolResultItem = result.context.events
                .flatMap((e) => e.content)
                .find(
                    (c) =>
                        c.type === "tool_result" && c.toolResult.toolCallId === "c1",
                );
            if (toolResultItem?.type === "tool_result") {
                checkEqual(
                    toolResultItem.toolResult.status,
                    "error",
                    "meta-deny: write_file denied without confirm callback",
                );
                check(
                    String(toolResultItem.toolResult.content[0]).includes("confirmation"),
                    "meta-deny: reason mentions confirmation",
                );
            } else {
                check(false, "meta-deny: tool_result event present");
            }
        }

        // ----- Approve mutate MCP tool -----
        {
            const tools = await loadMcpTools(connection, {
                calculator: { permission: "mutate" },
            });
            const client = new ScriptedClient([
                toolCallResponse([makeToolCall("c1", "calculator", { expression: "10 - 4" })]),
                textResponse("6"),
            ]);
            const agent = new Agent({
                llmClient: client,
                tools,
                confirmToolCall: () => true,
            });
            const result = await agent.run("go");

            const toolResultItem = result.context.events
                .flatMap((e) => e.content)
                .find((c) => c.type === "tool_result");
            if (toolResultItem?.type === "tool_result") {
                checkEqual(
                    toolResultItem.toolResult.status,
                    "success",
                    "permissions/approved: success status",
                );
            } else {
                check(false, "permissions/approved: tool_result event present");
            }
        }

        // ----- Error propagation: divide by zero via Agent -----
        {
            const tools = await loadMcpTools(connection);
            const client = new ScriptedClient([
                toolCallResponse([makeToolCall("c1", "calculator", { expression: "1 / 0" })]),
                textResponse("error handled"),
            ]);
            const agent = new Agent({ llmClient: client, tools });
            const result = await agent.run("go");

            const toolResultItem = result.context.events
                .flatMap((e) => e.content)
                .find((c) => c.type === "tool_result");
            if (toolResultItem?.type === "tool_result") {
                checkEqual(toolResultItem.toolResult.status, "error", "error-propagation: status error");
                checkEqual(
                    String(toolResultItem.toolResult.content[0]),
                    "division by zero",
                    "error-propagation: raw message (prefix stripped)",
                );
            } else {
                check(false, "error-propagation: tool_result event present");
            }
        }
    } finally {
        await connection.close();
    }
});