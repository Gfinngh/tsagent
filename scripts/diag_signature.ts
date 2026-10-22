/**
 * Diagnostic: dump the actual shape of a Gemini tool-call response, with
 * focus on where the thought_signature lives.
 *
 * Run with:
 *   npx tsx scripts/diag_signature.ts
 */

import { config as loadEnv } from "dotenv";
import { generateText, jsonSchema } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

loadEnv();

async function main(): Promise<void> {
    const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (apiKey === undefined || apiKey === "") {
        process.stderr.write("no GEMINI_API_KEY / GOOGLE_API_KEY\n");
        process.exit(2);
    }

    const client = createGoogleGenerativeAI({ apiKey });
    const model = client("gemini-3.5-flash-lite");

    const result = await generateText({
        model,
        messages: [
            {
                role: "user",
                content: "Use the calculator tool to compute 2 + 3.",
            },
        ],
        tools: {
            calculator: {
                description: "Evaluate a safe arithmetic expression.",
                inputSchema: jsonSchema({
                    type: "object",
                    properties: {
                        expression: { type: "string" },
                    },
                    required: ["expression"],
                }),
            },
        },
        toolChoice: "auto",
        maxRetries: 0,
    });

    process.stdout.write("=== result.toolCalls ===\n");
    console.dir(result.toolCalls, { depth: 8 });

    process.stdout.write("\n=== result.providerMetadata ===\n");
    console.dir(result.providerMetadata, { depth: 8 });

    process.stdout.write("\n=== result.response.messages ===\n");
    console.dir(result.response?.messages, { depth: 12 });

    process.stdout.write("\n=== result.response.messages[?].content[?] keys ===\n");
    const msgs = result.response?.messages ?? [];
    for (let i = 0; i < msgs.length; i += 1) {
        const m = msgs[i] as {
            role?: string;
            content?: unknown;
        };
        if (m?.role !== "assistant") continue;
        if (!Array.isArray(m.content)) continue;
        for (let j = 0; j < m.content.length; j += 1) {
            const part = m.content[j] as Record<string, unknown>;
            if (part?.type !== "tool-call") continue;
            process.stdout.write(
                `  assistant msg[${i}].content[${j}] keys: ${Object.keys(part).join(", ")}\n`,
            );
            if (part.providerMetadata !== undefined) {
                process.stdout.write("    providerMetadata:\n");
                console.dir(part.providerMetadata, { depth: 8 });
            }
            if (part.providerOptions !== undefined) {
                process.stdout.write("    providerOptions:\n");
                console.dir(part.providerOptions, { depth: 8 });
            }
        }
    }
}

main().catch((error) => {
    process.stderr.write(
        `diagnostic failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
});