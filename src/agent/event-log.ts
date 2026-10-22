import {
    closeSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readSync,
    writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { AgentEventSchema, type AgentEvent } from "./schemas.js";

export interface EventLog {
    append(event: AgentEvent): void;
    close(): void;
}

/** No-op log used when the caller does not want persistence. */
export class NullEventLog implements EventLog {
    append(_event: AgentEvent): void {
        // intentionally empty
    }
    close(): void {
        // intentionally empty
    }
}

/**
 * Append-only JSONL event log.
 *
 * - The file is lazily opened on the first `append` call. `close()`
 *   releases the handle; a later `append` reopens the file in append mode,
 *   so the log survives transient close/reopen cycles without losing the
 *   already-written prefix.
 * - Each record is written with a single `writeSync(fd, ...)` so the line
 *   is atomic for the small payloads we persist.
 * - `fsync: true` forces an fsync after every record (opt-in, off by
 *   default because it is slow).
 */
export class JsonlEventLog implements EventLog {
    private readonly path: string;
    private readonly fsync: boolean;
    private fd: number | null = null;

    constructor(path: string, options: { fsync?: boolean } = {}) {
        this.path = path;
        this.fsync = options.fsync ?? false;
    }

    get isOpen(): boolean {
        return this.fd !== null;
    }

    append(event: AgentEvent): void {
        const fd = this.ensureOpen();
        const payload = JSON.stringify(event) + "\n";
        writeSync(fd, payload);
        if (this.fsync) fsyncSync(fd);
    }

    close(): void {
        if (this.fd !== null) {
            closeSync(this.fd);
            this.fd = null;
        }
    }

    private ensureOpen(): number {
        if (this.fd !== null) return this.fd;
        const dir = dirname(this.path);
        if (dir !== "." && dir !== "") {
            mkdirSync(dir, { recursive: true });
        }
        this.fd = openSync(this.path, "a");
        return this.fd;
    }
}

export class EventLogFormatError extends Error {
    readonly path: string;
    readonly lineNumber: number;

    constructor(message: string, path: string, lineNumber: number) {
        super(`${message} (${path}:${lineNumber})`);
        this.name = "EventLogFormatError";
        this.path = path;
        this.lineNumber = lineNumber;
    }
}

export interface ReadEventLogOptions {
    /** Called when an unterminated final line is detected. Default: warn to stderr. */
    onTruncatedTail?: (path: string, lineNumber: number, raw: string) => void;
    /** Called when a blank interior line is skipped. Default: silent. */
    onBlankLine?: (path: string, lineNumber: number) => void;
}

/** Bytes per `readSync` call. */
const READ_CHUNK_SIZE = 64 * 1024;

/**
 * Read a JSONL event log.
 *
 * Memory: bounded by the longest single line, not the file size. Uses
 * chunked `readSync` instead of `readFileSync` so that a 100 MB log with
 * normal 1–2 KB lines does not allocate 100 MB up front.
 *
 * Semantics:
 * - Blank interior lines are skipped (and optionally reported).
 * - An unterminated final line is treated as a crashed writer: it is
 *   warned about and skipped, even if its contents happen to be valid JSON,
 *   because we cannot distinguish a clean write from a crash that happened
 *   between the JSON payload and the trailing newline.
 * - A malformed interior line (bad JSON, or JSON that fails schema
 *   validation) throws `EventLogFormatError` naming the path and line.
 */
export function readEventLog(
    path: string,
    options: ReadEventLogOptions = {},
): AgentEvent[] {
    const onTruncated = options.onTruncatedTail ?? defaultTruncatedWarning;
    const onBlank = options.onBlankLine ?? noop;

    const events: AgentEvent[] = [];
    const fd = openSync(path, "r");
    let lineNumber = 0;
    let pending = Buffer.alloc(0);
    const readBuffer = Buffer.alloc(READ_CHUNK_SIZE);

    try {
        let bytesRead: number;
        while ((bytesRead = readSync(fd, readBuffer, 0, READ_CHUNK_SIZE, null)) > 0) {
            // Copy out of the reusable readBuffer so `pending` survives the
            // next iteration. 64 KiB per chunk; the underlying memory is
            // released as soon as `pending` is trimmed below.
            const slice = Buffer.from(readBuffer.subarray(0, bytesRead));
            pending =
                pending.length === 0 ? slice : Buffer.concat([pending, slice]);

            // Drain every complete line from `pending`. `\n` (0x0A) never
            // appears inside a multi-byte UTF-8 sequence, so byte-level
            // splitting is safe even for non-ASCII content.
            let start = 0;
            let newlineIndex: number;
            while ((newlineIndex = pending.indexOf(0x0a, start)) !== -1) {
                lineNumber += 1;
                const line = pending.subarray(start, newlineIndex).toString("utf8");
                processLine(line, lineNumber);
                start = newlineIndex + 1;
            }
            // Keep the trailing partial line (no newline yet).
            if (start < pending.length) {
                pending = Buffer.from(pending.subarray(start));
            } else {
                pending = Buffer.alloc(0);
            }
        }

        // Trailing bytes without a newline = the writer crashed before
        // finishing the final record. Warn and skip.
        if (pending.length > 0) {
            lineNumber += 1;
            onTruncated(path, lineNumber, pending.toString("utf8"));
        }
    } finally {
        closeSync(fd);
    }

    return events;

    function processLine(line: string, lineNo: number): void {
        if (line === "") {
            onBlank(path, lineNo);
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch (error) {
            throw new EventLogFormatError(
                `invalid JSON: ${(error as Error).message}`,
                path,
                lineNo,
            );
        }

        const result = AgentEventSchema.safeParse(parsed);
        if (!result.success) {
            throw new EventLogFormatError(
                `invalid event shape: ${result.error.message}`,
                path,
                lineNo,
            );
        }

        events.push(result.data);
    }
}

/** Convenience iterator over `readEventLog`. */
export function* iterEventLog(
    path: string,
    options: ReadEventLogOptions = {},
): IterableIterator<AgentEvent> {
    for (const event of readEventLog(path, options)) yield event;
}

function noop(): void {
    // intentionally empty
}

function defaultTruncatedWarning(
    path: string,
    lineNumber: number,
    _raw: string,
): void {
    process.stderr.write(
        `[event-log] ${path}:${lineNumber}: truncated final line (writer crashed?); skipped\n`,
    );
}