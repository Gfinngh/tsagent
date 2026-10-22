import {
    context,
    trace,
    SpanStatusCode,
    type AttributeValue,
    type Span,
    type Tracer,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
    BatchSpanProcessor,
    InMemorySpanExporter,
    SimpleSpanProcessor,
    type ReadableSpan,
    type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

// =========================================================================
// Public types
// =========================================================================

export interface TracingInitOptions {
    /** Register an in-memory exporter; enables `inMemorySpans()`. */
    inMemory?: boolean;
    /** Service name. Defaults to `TSAGENT` / `OTEL_SERVICE_NAME`. */
    serviceName?: string;
    /** Register the OTLP exporter. Default: auto-detect from env. */
    otlp?: boolean;
    /**
     * Additional span processors to register alongside the built-in
     * in-memory and OTLP ones. Primarily for tests (e.g. injecting a
     * hanging processor to exercise the shutdown timeout) and for
     * plugging in a custom exporter.
     */
    additionalProcessors?: SpanProcessor[];
}

export interface SpanHandle {
    setAttribute(key: string, value: unknown): void;
    setAttributes(attrs: Record<string, unknown>): void;
    recordException(error: Error): void;
    setStatus(status: "ok" | "error", message?: string): void;
    end(): void;
}

export interface InMemorySpan {
    name: string;
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    attributes: Record<string, unknown>;
    status: { code: "unset" | "ok" | "error"; message?: string };
    events: Array<{ name: string; attributes?: Record<string, unknown> }>;
    startTimeMs: number;
    endTimeMs: number;
}

// =========================================================================
// Module state
// =========================================================================

let provider: NodeTracerProvider | null = null;
let tracer: Tracer | null = null;
let inMemoryExporter: InMemorySpanExporter | null = null;

/**
 * Upper bound on `provider.shutdown()`. Real exporters (in-memory or
 * OTLP-with-reachable-endpoint) flush in milliseconds; a hanging
 * exporter would otherwise hang `process.exit` at CLI shutdown. 5s is
 * generous for a single batch flush.
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

// =========================================================================
// Lifecycle
// =========================================================================

/**
 * Initialize tracing. Idempotent — calling twice is a no-op until
 * `shutdownTracing()` is called. Registers:
 * - The in-memory exporter (if `inMemory: true`).
 * - The OTLP exporter (if `otlp: true`, or if an endpoint is resolvable
 *   from `OTEL_EXPORTER_OTLP_ENDPOINT` or Langfuse env vars).
 * - Any `additionalProcessors` provided by the caller.
 */
export function initTracing(options: TracingInitOptions = {}): void {
    if (provider !== null) return;

    if (
        process.env.OTEL_SERVICE_NAME === undefined ||
        process.env.OTEL_SERVICE_NAME === ""
    ) {
        process.env.OTEL_SERVICE_NAME = options.serviceName ?? "tsagent";
    }

    ensureContextManager();

    const processors: SpanProcessor[] = [];

    if (options.inMemory === true) {
        inMemoryExporter = new InMemorySpanExporter();
        processors.push(new SimpleSpanProcessor(inMemoryExporter));
    }

    const autoOtlp = resolveOtlpEndpoint() !== null;
    const shouldOtlp = options.otlp ?? autoOtlp;
    if (shouldOtlp) {
        const endpoint = resolveOtlpEndpoint();
        if (endpoint !== null) {
            const exporter = new OTLPTraceExporter({
                url: endpoint,
                headers: resolveOtlpHeaders(),
            });
            processors.push(new BatchSpanProcessor(exporter));
        }
    }

    if (options.additionalProcessors !== undefined) {
        for (const p of options.additionalProcessors) {
            processors.push(p);
        }
    }

    const newProvider = new NodeTracerProvider({ spanProcessors: processors });
    tracer = newProvider.getTracer("tsagent", "0.1.0");
    provider = newProvider;
}

/**
 * Flush and dispose. Subsequent calls to `span()` are no-ops.
 *
 * Bounded by `SHUTDOWN_TIMEOUT_MS` so a hanging exporter (or a slow
 * OTLP endpoint) cannot hang the CLI's exit path. If the timeout
 * fires, the internal state is already cleared — subsequent calls are
 * no-ops. The provider's in-flight flush may still complete
 * asynchronously after the timeout; that is acceptable (spans are
 * best-effort telemetry).
 */
export async function shutdownTracing(): Promise<void> {
    if (provider === null) return;
    const p = provider;
    provider = null;
    tracer = null;
    inMemoryExporter = null;
    await Promise.race([
        p.shutdown().catch(() => {
            /* swallow flush errors — shutdown must never throw */
        }),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
}

export function isTracingEnabled(): boolean {
    return provider !== null;
}

// =========================================================================
// Span helpers
// =========================================================================

const NOOP_SPAN_HANDLE: SpanHandle = {
    setAttribute() { },
    setAttributes() { },
    recordException() { },
    setStatus() { },
    end() { },
};

/** Start a span. Returns a no-op handle when tracing is disabled. */
export function span(
    name: string,
    attributes?: Record<string, unknown>,
): SpanHandle {
    if (tracer === null) return NOOP_SPAN_HANDLE;
    const raw = tracer.startSpan(name, { attributes: toOtelAttrs(attributes) });
    return wrapSpan(raw);
}

/**
 * Run `fn` inside a span. The span becomes the ambient parent for any
 * nested `span()` / `withSpan()` calls. If `fn` throws, the span records
 * the exception and sets `ERROR` status before re-throwing. If `fn`
 * returns normally, the status is left at whatever `fn` set (or `UNSET`).
 */
export async function withSpan<T>(
    name: string,
    fn: (span: SpanHandle) => Promise<T> | T,
    attributes?: Record<string, unknown>,
): Promise<T> {
    if (tracer === null) return fn(NOOP_SPAN_HANDLE);

    const raw = tracer.startSpan(name, { attributes: toOtelAttrs(attributes) });
    const ctx = trace.setSpan(context.active(), raw);
    try {
        return await context.with(ctx, async () => fn(wrapSpan(raw)));
    } catch (error) {
        if (error instanceof Error) {
            raw.recordException(error);
            raw.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        }
        throw error;
    } finally {
        raw.end();
    }
}

function wrapSpan(raw: Span): SpanHandle {
    return {
        setAttribute(key, value) {
            const converted = toOtelAttrValue(value);
            if (converted !== undefined) raw.setAttribute(key, converted);
        },
        setAttributes(attrs) {
            raw.setAttributes(toOtelAttrs(attrs));
        },
        recordException(error) {
            raw.recordException(error);
        },
        setStatus(status, message) {
            raw.setStatus({
                code: status === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
                ...(message !== undefined ? { message } : {}),
            });
        },
        end() {
            raw.end();
        },
    };
}

// =========================================================================
// In-memory inspection
// =========================================================================

/** Every span recorded since the last `initTracing({ inMemory: true })`. */
export function inMemorySpans(): ReadonlyArray<InMemorySpan> {
    if (inMemoryExporter === null) return [];
    return inMemoryExporter.getFinishedSpans().map(convertSpan);
}

function convertSpan(span: ReadableSpan): InMemorySpan {
    const code =
        span.status.code === SpanStatusCode.OK
            ? "ok"
            : span.status.code === SpanStatusCode.ERROR
                ? "error"
                : "unset";
    const status: InMemorySpan["status"] = { code };
    if (span.status.message !== undefined) status.message = span.status.message;
    return {
        name: span.name,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parentSpanId: span.parentSpanId ?? null,
        attributes: { ...span.attributes } as Record<string, unknown>,
        status,
        events: span.events.map((e) => {
            const out: { name: string; attributes?: Record<string, unknown> } = {
                name: e.name,
            };
            if (e.attributes !== undefined) {
                out.attributes = { ...e.attributes } as Record<string, unknown>;
            }
            return out;
        }),
        startTimeMs: hrTimeToMs(span.startTime),
        endTimeMs: hrTimeToMs(span.endTime),
    };
}

function hrTimeToMs(time: [number, number]): number {
    return time[0] * 1000 + time[1] / 1_000_000;
}

// =========================================================================
// OTLP / Langfuse endpoint + headers
// =========================================================================

/**
 * Resolve the OTLP trace endpoint from env vars.
 *
 * Priority:
 * 1. `OTEL_EXPORTER_OTLP_ENDPOINT` (with `/v1/traces` appended if absent).
 * 2. Langfuse via `LANGFUSE_HOST` + `LANGFUSE_PUBLIC_KEY` +
 *    `LANGFUSE_SECRET_KEY` → `{host}/api/public/otel/v1/traces`.
 * 3. `null` (tracing falls back to in-memory only).
 */
export function resolveOtlpEndpoint(
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    const explicit = env.OTEL_EXPORTER_OTLP_ENDPOINT;
    if (explicit !== undefined && explicit !== "") {
        return explicit.endsWith("/v1/traces")
            ? explicit
            : `${explicit.replace(/\/$/, "")}/v1/traces`;
    }
    const host = env.LANGFUSE_HOST;
    const pub = env.LANGFUSE_PUBLIC_KEY;
    const sec = env.LANGFUSE_SECRET_KEY;
    if (
        host !== undefined &&
        host !== "" &&
        pub !== undefined &&
        pub !== "" &&
        sec !== undefined &&
        sec !== ""
    ) {
        return `${host.replace(/\/$/, "")}/api/public/otel/v1/traces`;
    }
    return null;
}

/**
 * Resolve OTLP headers. If `OTEL_EXPORTER_OTLP_HEADERS` is set it is
 * parsed as `key=value,key=value`. Otherwise, if Langfuse credentials are
 * present, produces `Authorization: Basic <base64(pub:sec)>`.
 */
export function resolveOtlpHeaders(
    env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
    const explicit = env.OTEL_EXPORTER_OTLP_HEADERS;
    if (explicit !== undefined && explicit !== "") {
        const headers: Record<string, string> = {};
        for (const pair of explicit.split(",")) {
            const idx = pair.indexOf("=");
            if (idx <= 0) continue;
            const key = pair.slice(0, idx).trim();
            const value = pair.slice(idx + 1).trim();
            if (key.length > 0) headers[key] = value;
        }
        return headers;
    }
    const pub = env.LANGFUSE_PUBLIC_KEY;
    const sec = env.LANGFUSE_SECRET_KEY;
    if (
        pub !== undefined &&
        pub !== "" &&
        sec !== undefined &&
        sec !== ""
    ) {
        return {
            Authorization: `Basic ${Buffer.from(`${pub}:${sec}`).toString("base64")}`,
        };
    }
    return {};
}

// =========================================================================
// Internal helpers
// =========================================================================

function ensureContextManager(): void {
    try {
        context.setGlobalContextManager(new AsyncLocalStorageContextManager());
    } catch {
        // Already set — ignore.
    }
}

function toOtelAttrs(
    attrs: Record<string, unknown> | undefined,
): Record<string, AttributeValue> {
    if (attrs === undefined) return {};
    const out: Record<string, AttributeValue> = {};
    for (const [k, v] of Object.entries(attrs)) {
        const converted = toOtelAttrValue(v);
        if (converted !== undefined) out[k] = converted;
    }
    return out;
}

function toOtelAttrValue(v: unknown): AttributeValue | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        return v;
    }
    if (Array.isArray(v)) {
        if (v.every((x) => typeof x === "string")) return v as string[];
        if (v.every((x) => typeof x === "number")) return v as number[];
        if (v.every((x) => typeof x === "boolean")) return v as boolean[];
        return JSON.stringify(v);
    }
    return JSON.stringify(v);
}