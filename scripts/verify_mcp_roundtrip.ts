import { McpConnection, McpToolError, mcpResultToMultipart } from "../src/agent/client.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { textPart, imagePart, resourcePart, structuredPart } from "../src/agent/tools/multipart.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(async () => {
    // =========================================================================
    // 1. mcpResultToMultipart — direct unit tests (no server required)
    // =========================================================================

    // Single text → [TextPart]
    {
        const result: CallToolResult = {
            content: [{ type: "text", text: "hello" }],
        };
        const parts = mcpResultToMultipart(result, "t");
        checkEqual(parts.length, 1, "single-text: one part");
        checkEqual(parts[0], textPart("hello"), "single-text: TextPart");
    }

    // Two texts → [MultipartContent] with two parts
    {
        const result: CallToolResult = {
            content: [
                { type: "text", text: "a" },
                { type: "text", text: "b" },
            ],
        };
        const parts = mcpResultToMultipart(result, "t");
        checkEqual(parts.length, 1, "two-texts: one array element");
        const mp = parts[0] as { type: string; parts: unknown[] };
        checkEqual(mp.type, "multipart", "two-texts: multipart wrapper");
        checkEqual(mp.parts.length, 2, "two-texts: two inner parts");
        checkEqual(mp.parts[0], textPart("a"), "two-texts: first part");
        checkEqual(mp.parts[1], textPart("b"), "two-texts: second part");
    }

    // Image → [ImagePart]
    {
        const result: CallToolResult = {
            content: [
                { type: "image", mimeType: "image/png", data: "AAAA" },
            ],
        };
        const parts = mcpResultToMultipart(result, "t");
        checkEqual(parts.length, 1, "image: one part");
        checkEqual(parts[0], imagePart("image/png", "AAAA"), "image: ImagePart");
    }

    // Image with missing mimeType → defaults to application/octet-stream
    {
        const result = {
            content: [{ type: "image", data: "AAAA" }],
        } as unknown as CallToolResult;
        const parts = mcpResultToMultipart(result, "t");
        checkEqual(
            parts[0],
            imagePart("application/octet-stream", "AAAA"),
            "image/no-mime: defaults to octet-stream",
        );
    }

    // Embedded resource with text → resource part with text
    {
        const result: CallToolResult = {
            content: [
                {
                    type: "resource",
                    resource: {
                        uri: "file:///x.txt",
                        mimeType: "text/plain",
                        text: "contents",
                    },
                },
            ],
        };
        const parts = mcpResultToMultipart(result, "t");
        checkEqual(
            parts[0],
            resourcePart({
                uri: "file:///x.txt",
                mimeType: "text/plain",
                text: "contents",
            }),
            "resource/text: correct part",
        );
    }

    // Embedded resource with blob → resource part with blob
    {
        const result: CallToolResult = {
            content: [
                {
                    type: "resource",
                    resource: {
                        uri: "file:///x.bin",
                        mimeType: "application/octet-stream",
                        blob: "AAAA",
                    },
                },
            ],
        };
        const parts = mcpResultToMultipart(result, "t");
        checkEqual(
            parts[0],
            resourcePart({
                uri: "file:///x.bin",
                mimeType: "application/octet-stream",
                blob: "AAAA",
            }),
            "resource/blob: correct part",
        );
    }

    // Resource link → resource part with uri + mimeType
    {
        const result = {
            content: [
                { type: "resource_link", uri: "file:///y", mimeType: "text/plain", name: "Y" },
            ],
        } as unknown as CallToolResult;
        const parts = mcpResultToMultipart(result, "t");
        checkEqual(
            parts[0],
            resourcePart({ uri: "file:///y", mimeType: "text/plain" }),
            "resource_link: correct part",
        );
    }

    // Unknown block type → structured part
    {
        const result = {
            content: [{ type: "custom_thing", payload: { a: 1 } }],
        } as unknown as CallToolResult;
        const parts = mcpResultToMultipart(result, "t");
        const sp = parts[0] as { type: string; data: unknown };
        checkEqual(sp.type, "structured", "unknown: structured part");
        checkEqual(
            sp.data,
            { type: "custom_thing", payload: { a: 1 } },
            "unknown: raw block preserved",
        );
    }

    // Empty content + structuredContent → one structured part
    {
        const result: CallToolResult = {
            content: [],
            structuredContent: { result: 42 },
        };
        const parts = mcpResultToMultipart(result, "t");
        checkEqual(parts.length, 1, "structured-fallback: one part");
        checkEqual(
            parts[0],
            structuredPart({ result: 42 }),
            "structured-fallback: StructuredPart",
        );
    }

    // Empty content + no structuredContent → []
    {
        const result: CallToolResult = { content: [] };
        const parts = mcpResultToMultipart(result, "t");
        checkEqual(parts.length, 0, "empty: no parts");
    }

    // isError → throws McpToolError
    {
        const result: CallToolResult = {
            content: [{ type: "text", text: "boom" }],
            isError: true,
        };
        let threw = false;
        let message = "";
        try {
            mcpResultToMultipart(result, "my_tool");
        } catch (error) {
            threw = error instanceof McpToolError;
            if (error instanceof McpToolError) {
                message = error.message;
                checkEqual(error.toolName, "my_tool", "isError: toolName preserved");
            }
        }
        check(threw, "isError: throws McpToolError");
        checkEqual(message, "boom", "isError: raw message");
    }

    // isError + SDK prefix → prefix stripped
    {
        const result: CallToolResult = {
            content: [
                { type: "text", text: "Error executing tool calculator: division by zero" },
            ],
            isError: true,
        };
        let message = "";
        try {
            mcpResultToMultipart(result, "calculator");
        } catch (error) {
            if (error instanceof McpToolError) message = error.message;
        }
        checkEqual(message, "division by zero", "isError/sdk-prefix: stripped");
    }

    // =========================================================================
    // 2. Real subprocess round-trip
    // =========================================================================

    const connection = new McpConnection("tsagent", {
        command: process.execPath,
        args: ["--import", "tsx", "src/agent/server.ts"],
        connectTimeoutMs: 30_000,
    });

    try {
        await connection.connect();
        check(true, "connect: subprocess spawned and session initialized");
        checkEqual(connection.isConnected, true, "connect: isConnected");

        // ----- listTools -----
        const tools = await connection.listTools();
        check(tools.length >= 2, `listTools: at least 2 tools (got ${tools.length})`);
        const names = tools.map((t) => t.name).sort();
        check(names.includes("calculator"), "listTools: calculator present");
        check(names.includes("greet"), "listTools: greet present");

        // ----- calculator success -----
        {
            const result = await connection.callTool("calculator", {
                expression: "2 + 3",
            });
            checkEqual(result.isError, false, "calculator/success: isError false");
            checkEqual(result.content.length, 1, "calculator/success: one content block");
            const block = result.content[0] as { type: string; text: string };
            checkEqual(block.type, "text", "calculator/success: content is text");
            checkEqual(block.text, "5", "calculator/success: text is '5'");
        }

        // ----- calculator divide-by-zero → error -----
        {
            const result = await connection.callTool("calculator", {
                expression: "1 / 0",
            });
            checkEqual(result.isError, true, "calculator/error: isError true");
            const block = result.content[0] as { type: string; text: string };
            checkEqual(
                block.text,
                "division by zero",
                "calculator/error: message 'division by zero'",
            );

            // Also verify the client wrapper throws.
            let threw = false;
            try {
                mcpResultToMultipart(result, "calculator");
            } catch (error) {
                threw = error instanceof McpToolError;
            }
            check(threw, "calculator/error: mcpResultToMultipart throws McpToolError");
        }

        // ----- greet -----
        {
            const result = await connection.callTool("greet", { name: "Alice" });
            checkEqual(result.isError, false, "greet: isError false");
            const block = result.content[0] as { type: string; text: string };
            checkEqual(block.text, "Hello, Alice!", "greet: correct response");
        }

        // ----- conversion from real result -----
        {
            const result = await connection.callTool("calculator", {
                expression: "10 * 4",
            });
            const parts = mcpResultToMultipart(result, "calculator");
            checkEqual(parts.length, 1, "convert: one part");
            checkEqual(parts[0], textPart("40"), "convert: text part '40'");
        }
    } finally {
        await connection.close();
    }

    checkEqual(connection.isConnected, false, "close: isConnected false");
});