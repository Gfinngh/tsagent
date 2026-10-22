/**
 * Verification: error-message hygiene.
 *
 * `translateError` is the single choke point for provider errors before
 * they become `LlmResponse.errorMessage` / `errorMetadata`. Sensitive
 * fields in the provider's error body must be scrubbed before the value
 * is exposed; the message itself must be bounded.
 *
 * Covers:
 *   - `Authorization`, `api_key`, `x-goog-api-key`, `token`, `cookie`
 *     and other sensitive keys are redacted
 *   - non-sensitive keys (`code`, `status`, `message`) survive untouched
 *   - nested objects are scrubbed recursively
 *   - arrays of objects are scrubbed element-by-element
 *   - large `providerData` payloads are replaced with a bounded preview
 *   - long error messages are truncated
 *   - a `NoOutputGeneratedError`-style wrapper resolves to its cause
 *   - plain `TransportError` passes through unchanged
 */

import { TransportError } from "../src/agent/llm.js";
import { translateError } from "../src/agent/transport/google.js";
import { check, checkEqual, runScript } from "./_verify-common.js";

runScript(() => {
    // ===== 1. Pass-through: TransportError =====
    {
        const original = new TransportError("already translated", { statusCode: 500 });
        const translated = translateError(original);
        check(
            translated === original,
            "passthrough: TransportError returned unchanged",
        );
    }

    // ===== 2. Sensitive keys are redacted =====
    {
        const upstream = {
            statusCode: 401,
            message: "unauthorized",
            data: {
                error: {
                    code: "UNAUTHENTICATED",
                    status: "UNAUTHENTICATED",
                    message: "invalid credentials",
                    authorization: "Bearer sk-secret-value",
                    api_key: "sk-leaked",
                    "x-goog-api-key": "AIzaSyLEAKED",
                    token: "tok-123",
                    cookie: "session=abc",
                },
            },
        };
        const translated = translateError(upstream);
        checkEqual(translated.statusCode, 401, "scrub: statusCode preserved");
        const data = translated.providerData ?? {};
        checkEqual(data.code, "UNAUTHENTICATED", "scrub: code preserved");
        checkEqual(data.status, "UNAUTHENTICATED", "scrub: status preserved");
        checkEqual(data.message, "invalid credentials", "scrub: message preserved");
        checkEqual(data.authorization, "[redacted]", "scrub: authorization redacted");
        checkEqual(data.api_key, "[redacted]", "scrub: api_key redacted");
        checkEqual(
            data["x-goog-api-key"],
            "[redacted]",
            "scrub: x-goog-api-key redacted",
        );
        checkEqual(data.token, "[redacted]", "scrub: token redacted");
        checkEqual(data.cookie, "[redacted]", "scrub: cookie redacted");
    }

    // ===== 3. Nested objects are scrubbed recursively =====
    {
        const upstream = {
            statusCode: 500,
            message: "server error",
            data: {
                error: {
                    code: "INTERNAL",
                    metadata: {
                        headers: {
                            authorization: "Bearer inner-secret",
                            "user-agent": "test-agent",
                        },
                    },
                },
            },
        };
        const translated = translateError(upstream);
        const data = translated.providerData ?? {};
        const metadata = data.metadata as Record<string, unknown> | undefined;
        const headers = metadata?.headers as Record<string, unknown> | undefined;
        checkEqual(headers?.authorization, "[redacted]", "scrub/nested: auth redacted");
        checkEqual(headers?.["user-agent"], "test-agent", "scrub/nested: safe key preserved");
    }

    // ===== 4. Arrays of objects are scrubbed element-by-element =====
    {
        const upstream = {
            statusCode: 400,
            message: "bad request",
            data: {
                error: {
                    code: "INVALID",
                    details: [
                        { type: "Help", url: "https://example.com" },
                        { type: "Auth", token: "leak-123" },
                    ],
                },
            },
        };
        const translated = translateError(upstream);
        const data = translated.providerData ?? {};
        const details = data.details as Array<Record<string, unknown>>;
        checkEqual(details[0]?.url, "https://example.com", "scrub/array: safe url preserved");
        checkEqual(details[1]?.token, "[redacted]", "scrub/array: token redacted");
    }

    // ===== 5. Long error message is truncated =====
    {
        const longMessage = "x".repeat(5000);
        const upstream = { statusCode: 500, message: longMessage };
        const translated = translateError(upstream);
        check(
            translated.message.length <= 1000,
            `truncate: message bounded (got ${translated.message.length} chars)`,
        );
        check(
            translated.message.endsWith("…"),
            "truncate: message ends with ellipsis",
        );
    }

    // ===== 6. Large providerData replaced with bounded preview =====
    {
        const hugePayload = "y".repeat(10_000);
        const upstream = {
            statusCode: 400,
            message: "payload too large",
            data: {
                error: {
                    code: "PAYLOAD_TOO_LARGE",
                    huge_field: hugePayload,
                },
            },
        };
        const translated = translateError(upstream);
        const data = translated.providerData ?? {};
        checkEqual(data.truncated, true, "bound: large providerData is truncated");
        check(
            typeof data.preview === "string",
            "bound: preview string is present",
        );
        const preview = data.preview as string;
        check(
            preview.length <= 500,
            `bound: preview bounded (got ${preview.length})`,
        );
    }

    // ===== 7. Wrapper error resolves to its cause =====
    {
        const wrapper = {
            message: "No output generated. Check the stream for errors.",
            cause: {
                statusCode: 503,
                message: "model overloaded",
                data: {
                    error: {
                        code: 503,
                        status: "UNAVAILABLE",
                        message: "model overloaded",
                    },
                },
            },
        };
        const translated = translateError(wrapper);
        checkEqual(translated.statusCode, 503, "wrapper: cause status extracted");
        checkEqual(
            translated.providerStatus,
            "UNAVAILABLE",
            "wrapper: cause providerStatus extracted",
        );
        checkEqual(
            translated.message,
            "No output generated. Check the stream for errors.",
            "wrapper: wrapper message preserved (not cause)",
        );
    }

    // ===== 8. Google-style RetryInfo in details[] =====
    {
        const upstream = {
            statusCode: 429,
            message: "quota",
            data: {
                error: {
                    code: 429,
                    status: "RESOURCE_EXHAUSTED",
                    message: "quota exceeded",
                    details: [
                        {
                            "@type": "type.googleapis.com/google.rpc.RetryInfo",
                            retryDelay: "34835s",
                        },
                    ],
                },
            },
        };
        const translated = translateError(upstream);
        checkEqual(
            translated.retryAfterMs,
            34835_000,
            "retry: Google RetryInfo parsed from details[]",
        );
    }

    // ===== 9. Sensitive keys are case-insensitive =====
    {
        const upstream = {
            statusCode: 401,
            message: "unauth",
            data: {
                error: {
                    code: "AUTH",
                    Authorization: "Bearer x",
                    API_KEY: "y",
                    "Set-Cookie": "z",
                },
            },
        };
        const translated = translateError(upstream);
        const data = translated.providerData ?? {};
        checkEqual(data.Authorization, "[redacted]", "case: Authorization redacted");
        checkEqual(data.API_KEY, "[redacted]", "case: API_KEY redacted");
        checkEqual(data["Set-Cookie"], "[redacted]", "case: Set-Cookie redacted");
    }
});