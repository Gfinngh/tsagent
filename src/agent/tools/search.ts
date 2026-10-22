import { z } from "zod";
import { BaseTool, FunctionTool, ToolError } from "./base.js";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const MAX_BODY_PREVIEW = 500;

export interface SearchWebOptions {
    /** Overrides `process.env.TAVILY_API_KEY` when set. */
    apiKey?: string;
}

interface TavilyResult {
    title?: string;
    url?: string;
    content?: string;
}

interface TavilyResponse {
    results?: TavilyResult[];
}

/**
 * Web search via Tavily. Missing API key → clean `ToolError` (the server
 * surfaces it as `isError: true` with the message). Non-200 → `ToolError`
 * with the status and a truncated body preview. Success → a formatted
 * plain-text block the model can quote directly.
 */
export function makeSearchWebTool(options: SearchWebOptions = {}): BaseTool {
    return new FunctionTool({
        name: "search_web",
        description:
            "Search the web via Tavily and return the top results as text. " +
            "Requires TAVILY_API_KEY to be configured on the server.",
        permission: "read",
        argsSchema: z.object({
            query: z.string().min(1),
            maxResults: z.number().int().min(1).max(20).default(5),
        }),
        fn: async ({ query, maxResults }) => {
            const apiKey = options.apiKey ?? process.env.TAVILY_API_KEY;
            if (apiKey === undefined || apiKey === "") {
                throw new ToolError("TAVILY_API_KEY is not set");
            }

            let response: Response;
            try {
                response = await fetch(TAVILY_ENDPOINT, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        api_key: apiKey,
                        query,
                        max_results: maxResults,
                    }),
                });
            } catch (error) {
                throw new ToolError(
                    `Tavily request failed: ${(error as Error).message}`,
                );
            }

            if (!response.ok) {
                const body = await response.text().catch(() => "");
                const preview = body.slice(0, MAX_BODY_PREVIEW);
                throw new ToolError(
                    `Tavily returned ${response.status} ${response.statusText}: ${preview}`,
                );
            }

            let data: TavilyResponse;
            try {
                data = (await response.json()) as TavilyResponse;
            } catch (error) {
                throw new ToolError(
                    `Tavily response was not valid JSON: ${(error as Error).message}`,
                );
            }

            const results = data.results ?? [];
            if (results.length === 0) {
                return `No results found for: ${query}`;
            }
            return results
                .map((r, i) => {
                    const title = r.title ?? "(no title)";
                    const url = r.url ?? "(no url)";
                    const snippet = (r.content ?? "").trim();
                    return `${i + 1}. ${title}\n   ${url}${snippet ? `\n   ${snippet}` : ""}`;
                })
                .join("\n\n");
        },
    });
}