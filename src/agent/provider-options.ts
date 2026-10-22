/**
 * Provider-option helpers.
 *
 * Internally we store thought signatures under the snake_case key
 * `thought_signature`. That is the format the Python source used and the
 * format the verification scripts assert on.
 *
 * At the AI SDK boundary the Google provider expects the camelCase key
 * `thoughtSignature` under `providerOptions.google`. `google.ts` is
 * responsible for that translation.
 *
 * `extractThoughtSignature` accepts both spellings so it works whether the
 * value came from an old log, a live AI SDK response, or an internal
 * record.
 */

export const DUMMY_SIGNATURE_KEY = "skip_thought_signature_validator";
export const THOUGHT_SIGNATURE_KEY = "thought_signature";
export const THOUGHT_SIGNATURE_CAMEL_KEY = "thoughtSignature";
export const THOUGHT_ID_SUFFIX = "__thought__";

/** Unwrap the legacy `{"google": {...}}` shape to a flat dict. */
export function unwrapLegacyProviderFields(
    fields: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
    if (fields === null || fields === undefined) return null;
    const keys = Object.keys(fields);
    if (keys.length === 1 && keys[0] === "google") {
        const inner = fields.google;
        if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
            return inner as Record<string, unknown>;
        }
    }
    return fields;
}

/** True if `value` is exactly the LiteLLM placeholder, not a real signature. */
export function isDummySignature(value: unknown): boolean {
    if (value === true) return true;
    if (typeof value !== "string") return false;
    return value === DUMMY_SIGNATURE_KEY;
}

/**
 * Extract the real signature from a flat provider-options dict, or
 * `null` if only a dummy placeholder is present.
 *
 * Accepts both:
 *   - `thoughtSignature` — AI SDK / Gemini 3 camelCase
 *   - `thought_signature` — legacy / internal snake_case
 *
 * Also handles `Uint8Array` values, normalizing to base64.
 */
export function extractThoughtSignature(
    fields: Record<string, unknown> | null | undefined,
): string | null {
    const unwrapped = unwrapLegacyProviderFields(fields);
    if (unwrapped === null) return null;

    for (const key of [THOUGHT_SIGNATURE_CAMEL_KEY, THOUGHT_SIGNATURE_KEY]) {
        const value = unwrapped[key];
        if (value === undefined || value === null) continue;
        if (isDummySignature(value)) continue;
        if (typeof value === "string") return value;
        if (value instanceof Uint8Array) {
            return Buffer.from(value).toString("base64");
        }
    }
    return null;
}

/** Attach a signature to a flat provider-options dict, replacing any existing. */
export function withThoughtSignature(
    fields: Record<string, unknown> | null | undefined,
    signature: string,
): Record<string, unknown> {
    const base = unwrapLegacyProviderFields(fields) ?? {};
    return { ...base, [THOUGHT_SIGNATURE_KEY]: signature };
}

/**
 * Decode a `tool_call_id` that carries the `__thought__` suffix, returning
 * the base id and the signature. Returns `null` if the suffix is absent.
 */
export function decodeThoughtId(
    id: string,
): { baseId: string; signature: string } | null {
    const idx = id.indexOf(THOUGHT_ID_SUFFIX);
    if (idx === -1) return null;
    return {
        baseId: id.slice(0, idx),
        signature: id.slice(idx + THOUGHT_ID_SUFFIX.length),
    };
}

/** Encode a `tool_call_id` with the `__thought__` suffix. */
export function encodeThoughtId(baseId: string, signature: string): string {
    return `${baseId}${THOUGHT_ID_SUFFIX}${signature}`;
}