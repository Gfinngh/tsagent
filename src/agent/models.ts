/**
 * Model chain and provider-prefix resolution.
 *
 * The Python source stores model IDs with a provider prefix
 * (`gemini/gemini-2.0-flash`) and resolves them with `resolveModel()`
 * before handing the bare ID to the provider SDK. `@ai-sdk/google` does
 * not accept the prefix, so we strip it here.
 *
 * The chain is ordered for fallback: entry 0 is tried first, entry N-1
 * is the last resort. Two canonical orders are defined:
 *   - `MODEL_CHAIN_PROD` — strongest first. Production.
 *   - `MODEL_CHAIN_TEST` — weakest first. Testing; burn quota slowly.
 *
 * `TSAGENT_MODEL_ORDER=prod|test` selects between them. Default: `test`.
 */

/** Production order: strongest → weakest. */
const MODEL_CHAIN_PROD: readonly string[] = [
    "gemini/gemini-3.8-flash",
    "gemini/gemini-3.6-flash",
    "gemini/gemini-3.5-flash-lite",
    "gemini/gemini-3.1-flash-lite",
    "gemini/gemini-3-flash-preview",
];

/** Testing order: weakest → strongest. Minimises quota burn on the good models. */
const MODEL_CHAIN_TEST: readonly string[] = [...MODEL_CHAIN_PROD].reverse();

type ModelOrder = "test" | "prod";

/** Resolve the current chain order from the environment. */
export function getModelOrder(): ModelOrder {
    const raw = (process.env.TSAGENT_MODEL_ORDER ?? "test").toLowerCase();
    return raw === "prod" ? "prod" : "test";
}

/** Current chain in fallback order (index 0 tried first). */
export function getModelChain(): string[] {
    const order = getModelOrder();
    return order === "prod"
        ? [...MODEL_CHAIN_PROD]
        : [...MODEL_CHAIN_TEST];
}

/**
 * Strip a provider prefix from a model ID.
 *
 *   "gemini/gemini-2.0-flash"  → "gemini-2.0-flash"
 *   "google/gemini-2.0-flash"  → "gemini-2.0-flash"
 *   "gemini-2.0-flash"         → "gemini-2.0-flash"  (no change)
 *
 * Throws on unknown provider prefixes so a misconfiguration fails fast
 * rather than sending `unknown/foo` to Google and getting a 404.
 */
export function resolveModel(model: string): string {
    const slash = model.indexOf("/");
    if (slash < 0) return model;
    const provider = model.slice(0, slash);
    const bare = model.slice(slash + 1);
    if (provider === "gemini" || provider === "google") return bare;
    throw new Error(
        `unsupported provider prefix "${provider}" in model "${model}" — ` +
        `supported: gemini, google`,
    );
}