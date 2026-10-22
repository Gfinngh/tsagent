import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    EventLogFormatError,
    JsonlEventLog,
    NullEventLog,
    iterEventLog,
    readEventLog,
} from "../src/agent/event-log.js";
import {
    makeEvent,
    messageContentItem,
    type AgentEvent,
} from "../src/agent/schemas.js";
import { check, checkEqual, makeTempDir, runScript } from "./_verify-common.js";

runScript(() => {
    const tmp = makeTempDir("event-log");
    try {
        // ===== NullEventLog =====
        const nullLog = new NullEventLog();
        nullLog.append(makeTestEvent("x"));
        nullLog.close();
        check(true, "NullEventLog: append/close are no-ops");

        // ===== Lazy open =====
        const logPath = join(tmp.path, "fresh.jsonl");
        check(!existsSync(logPath), "lazy: file does not exist before append");
        const log = new JsonlEventLog(logPath);
        check(!existsSync(logPath), "lazy: file still absent after construction");
        const ev1 = makeTestEvent("one");
        log.append(ev1);
        check(existsSync(logPath), "lazy: file exists after first append");
        log.close();

        // ===== Round-trip single event =====
        const readBack = readEventLog(logPath);
        checkEqual(readBack.length, 1, "round-trip: one event");
        checkEqual(readBack[0]?.id, ev1.id, "round-trip: id matches");
        const firstContent = readBack[0]?.content[0];
        check(firstContent?.type === "message", "round-trip: content kind is 'message'");
        if (firstContent?.type === "message") {
            checkEqual(
                firstContent.message.content,
                "one",
                "round-trip: message content matches",
            );
        }

        // ===== Reopen after close =====
        log.append(makeTestEvent("two"));
        log.close();
        const readBack2 = readEventLog(logPath);
        checkEqual(readBack2.length, 2, "reopen: two events after reopen");
        checkEqual(readBack2.length, 2, "trailing newline: no phantom third event");

        // ===== Empty file =====
        const emptyPath = join(tmp.path, "empty.jsonl");
        writeFileSync(emptyPath, "");
        checkEqual(readEventLog(emptyPath), [], "empty file: yields []");

        // ===== Truncated final line (valid JSON, no trailing newline) =====
        const evA = makeTestEvent("a");
        const evB = makeTestEvent("b");
        const truncPath = join(tmp.path, "trunc.jsonl");
        writeFileSync(truncPath, JSON.stringify(evA) + "\n" + JSON.stringify(evB));
        let truncWarned = false;
        const readTrunc = readEventLog(truncPath, {
            onTruncatedTail: () => {
                truncWarned = true;
            },
        });
        checkEqual(readTrunc.length, 1, "truncated final line: only the first event is read");
        checkEqual(readTrunc[0]?.id, evA.id, "truncated final line: first event is evA");
        check(truncWarned, "truncated final line: warning fired");

        // ===== Truncated final line (invalid JSON) =====
        const truncPath2 = join(tmp.path, "trunc2.jsonl");
        writeFileSync(truncPath2, JSON.stringify(evA) + "\n" + '{"id":"partial');
        const readTrunc2 = readEventLog(truncPath2, { onTruncatedTail: () => { } });
        checkEqual(readTrunc2.length, 1, "truncated invalid final line: only first event read");
        checkEqual(readTrunc2[0]?.id, evA.id, "truncated invalid final line: first event is evA");

        // ===== Malformed interior line (bad JSON) =====
        const badPath = join(tmp.path, "bad.jsonl");
        writeFileSync(badPath, JSON.stringify(evA) + "\nnot-json\n" + JSON.stringify(evB) + "\n");
        let threw = false;
        let errorLine = 0;
        try {
            readEventLog(badPath);
        } catch (error) {
            if (error instanceof EventLogFormatError) {
                threw = true;
                errorLine = error.lineNumber;
            }
        }
        check(threw, "malformed interior line: throws EventLogFormatError");
        checkEqual(errorLine, 2, "malformed interior line: lineNumber is 2");

        // ===== Malformed interior line (valid JSON, bad shape) =====
        const badSchemaPath = join(tmp.path, "badschema.jsonl");
        writeFileSync(
            badSchemaPath,
            JSON.stringify(evA) + "\n" + '{"bad":"shape"}\n' + JSON.stringify(evB) + "\n",
        );
        let threwSchema = false;
        try {
            readEventLog(badSchemaPath);
        } catch (error) {
            if (error instanceof EventLogFormatError) threwSchema = true;
        }
        check(threwSchema, "invalid shape on interior line: throws EventLogFormatError");

        // ===== iterEventLog =====
        const iterated: AgentEvent[] = [];
        for (const ev of iterEventLog(logPath)) iterated.push(ev);
        checkEqual(iterated.length, 2, "iterEventLog: yields all events");
        checkEqual(
            iterated.map((ev) => ev.id),
            readBack2.map((ev) => ev.id),
            "iterEventLog: same order as readEventLog",
        );

        // ===== Parent directory auto-creation =====
        const nestedPath = join(tmp.path, "nested", "deep", "log.jsonl");
        check(!existsSync(join(tmp.path, "nested")), "nested: parent dir absent before append");
        const nestedLog = new JsonlEventLog(nestedPath);
        nestedLog.append(makeTestEvent("nested"));
        nestedLog.close();
        check(existsSync(nestedPath), "nested: file created with parent dirs");

        // ===== Blank interior line =====
        const blankPath = join(tmp.path, "blank.jsonl");
        writeFileSync(
            blankPath,
            JSON.stringify(evA) + "\n\n" + JSON.stringify(evB) + "\n",
        );
        checkEqual(
            readEventLog(blankPath).length,
            2,
            "blank interior line: skipped, two events read",
        );

        // ===== Missing file =====
        let missingThrew = false;
        try {
            readEventLog(join(tmp.path, "does-not-exist.jsonl"));
        } catch (error) {
            missingThrew = (error as NodeJS.ErrnoException).code === "ENOENT";
        }
        check(missingThrew, "readEventLog: throws ENOENT on missing file");
    } finally {
        tmp.cleanup();
    }
});

function makeTestEvent(text: string): AgentEvent {
    return makeEvent([messageContentItem({ role: "assistant", content: text })]);
}