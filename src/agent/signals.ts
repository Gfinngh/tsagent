/**
 * AbortSignal utilities shared by `agent.ts` and `fallback.ts`.
 * Extracted so both modules can use them without duplication or a
 * cross-dependency between them.
 */

/**
 * Merge two abort signals into one. The result aborts when either input
 * aborts. Uses `AbortSignal.any` when available (Node 20+); otherwise
 * subscribes to both and forwards.
 */
export function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
    if (typeof AbortSignal.any === "function") {
        return AbortSignal.any([a, b]);
    }
    if (a.aborted) return a;
    if (b.aborted) return b;
    const controller = new AbortController();
    a.addEventListener("abort", () => controller.abort(a.reason), { once: true });
    b.addEventListener("abort", () => controller.abort(b.reason), { once: true });
    return controller.signal;
}

/** Build an `AbortError` (name === "AbortError") for control flow. */
export function makeAbortError(): Error {
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
}

/** True if `error` is an abort signal (name === "AbortError"). */
export function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
}