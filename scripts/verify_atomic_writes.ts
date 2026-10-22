/**
 * Verification: atomic file writes.
 *
 * `writeAtomically` must produce the same final content as `writeFileSync`
 * for normal cases, never leave a `.tmp` file behind on success or
 * failure, and cleanly overwrite existing targets.
 *
 * The full crash-atomicity property (no partial file visible after a
 * SIGKILL during the write) is not directly testable in-process; it
 * follows from the `write-temp + fsync + rename` mechanism, which the
 * test exercises end-to-end.
 */

import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writeAtomically } from "../src/workflows/_shared.js";
import { check, checkEqual, makeTempDir, runScript } from "./_verify-common.js";

runScript(() => {
    const tmp = makeTempDir("atomic-writes");
    try {
        // ===== 1. Basic write =====
        {
            const target = join(tmp.path, "a.txt");
            writeAtomically(target, "hello world");
            checkEqual(readFileSync(target, "utf8"), "hello world", "basic: content written");
            checkNoTmpFiles(tmp.path, "basic: no .tmp files left behind");
        }

        // ===== 2. Overwrite existing =====
        {
            const target = join(tmp.path, "b.txt");
            writeFileSync(target, "old content", "utf8");
            writeAtomically(target, "new content");
            checkEqual(readFileSync(target, "utf8"), "new content", "overwrite: content replaced");
            checkNoTmpFiles(tmp.path, "overwrite: no .tmp files left behind");
        }

        // ===== 3. UTF-8 preserved =====
        {
            const target = join(tmp.path, "c.txt");
            const utf8 = "hello 世界 🎉";
            writeAtomically(target, utf8);
            checkEqual(readFileSync(target, "utf8"), utf8, "utf8: content preserved");
        }

        // ===== 4. Empty content =====
        {
            const target = join(tmp.path, "d.txt");
            writeAtomically(target, "");
            checkEqual(readFileSync(target, "utf8"), "", "empty: empty file written");
        }

        // ===== 5. Large content =====
        {
            const target = join(tmp.path, "e.bin");
            const large = "x".repeat(100_000);
            writeAtomically(target, large);
            checkEqual(readFileSync(target, "utf8"), large, "large: content preserved");
            checkNoTmpFiles(tmp.path, "large: no .tmp files left behind");
        }

        // ===== 6. Failure when target's parent dir doesn't exist =====
        {
            const target = join(tmp.path, "does-not-exist", "f.txt");
            let threw = false;
            try {
                writeAtomically(target, "should fail");
            } catch {
                threw = true;
            }
            check(threw, "missing-parent: throws");
            checkNoTmpFiles(tmp.path, "missing-parent: no .tmp files left behind");
        }

        // ===== 7. Two sequential writes to the same file =====
        {
            const target = join(tmp.path, "g.txt");
            writeAtomically(target, "first");
            writeAtomically(target, "second");
            checkEqual(readFileSync(target, "utf8"), "second", "sequential: last write wins");
            checkNoTmpFiles(tmp.path, "sequential: no .tmp files left behind");
        }

        // ===== 8. Many sequential writes to different files =====
        {
            const sub = join(tmp.path, "many");
            mkdirSync(sub, { recursive: true });
            for (let i = 0; i < 20; i += 1) {
                writeAtomically(join(sub, `file-${i}.txt`), `content ${i}`);
            }
            let allCorrect = true;
            for (let i = 0; i < 20; i += 1) {
                const content = readFileSync(join(sub, `file-${i}.txt`), "utf8");
                if (content !== `content ${i}`) {
                    allCorrect = false;
                    break;
                }
            }
            check(allCorrect, "many: all 20 files have correct content");
            checkNoTmpFiles(sub, "many: no .tmp files left behind");
        }

        // ===== 9. Concurrent writes to different files (sanity, not crash-atomicity) =====
        // Synchronous writes do not race, but this checks that rapid back-to-back
        // operations do not leave temp files behind or corrupt existing ones.
        {
            const targetA = join(tmp.path, "concurrent-a.txt");
            const targetB = join(tmp.path, "concurrent-b.txt");
            writeFileSync(targetA, "placeholder-a");
            writeFileSync(targetB, "placeholder-b");
            writeAtomically(targetA, "final-a");
            writeAtomically(targetB, "final-b");
            checkEqual(readFileSync(targetA, "utf8"), "final-a", "concurrent: file A correct");
            checkEqual(readFileSync(targetB, "utf8"), "final-b", "concurrent: file B correct");
        }
    } finally {
        tmp.cleanup();
    }
});

function checkNoTmpFiles(dir: string, label: string): void {
    const entries = readdirSync(dir);
    const tmpFiles = entries.filter((name) => name.endsWith(".tmp"));
    check(
        tmpFiles.length === 0,
        `${label} (found ${tmpFiles.length}: ${tmpFiles.join(", ")})`,
    );
    void existsSync;
}