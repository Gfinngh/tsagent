/**
 * 22 — Atomic file writes
 *
 * `writeAtomically()` writes to a uniquely-named `.tmp` sibling,
 * `fsync`s it to disk, then `rename`s over the target. On any reader
 * this makes the write appear as a single atomic operation: the target
 * either has the old content or the new content, never partial bytes.
 * On crash, no `.tmp` file is left behind on a subsequent successful
 * write; if the write itself fails, the temp is cleaned up in a
 * `finally`-equivalent.
 *
 * Used by the workflow artifact writers (notes-digest, trip-planner).
 * This example shows the primitive directly with before/after snapshots
 * of the directory listing. No LLM.
 *
 *   npx tsx examples/22-atomic-writes.ts
 */

import {
    existsSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writeAtomically } from "../src/workflows/_shared.js";
import { ensureDir, section } from "./_common.js";

const DIR = ".examples/atomic-writes";

function listTmpFiles(): string[] {
    return readdirSync(DIR).filter((name) => name.endsWith(".tmp"));
}

async function main(): Promise<void> {
    section("setup");
    rmSync(DIR, { recursive: true, force: true });
    ensureDir(DIR);
    console.log(`dir: ${DIR}`);

    section("1. basic write");
    {
        const target = join(DIR, "hello.txt");
        writeAtomically(target, "hello world");
        console.log(`  content: ${JSON.stringify(readFileSync(target, "utf8"))}`);
        console.log(`  .tmp files left: ${listTmpFiles().length} (expected 0)`);
    }

    section("2. overwrite existing");
    {
        const target = join(DIR, "hello.txt");
        writeFileSync(target, "old content");
        console.log(`  before: ${JSON.stringify(readFileSync(target, "utf8"))}`);
        writeAtomically(target, "new content");
        console.log(`  after:  ${JSON.stringify(readFileSync(target, "utf8"))}`);
        console.log(`  .tmp files left: ${listTmpFiles().length} (expected 0)`);
    }

    section("3. empty content");
    {
        const target = join(DIR, "empty.txt");
        writeAtomically(target, "");
        console.log(`  content: ${JSON.stringify(readFileSync(target, "utf8"))}`);
    }

    section("4. large content");
    {
        const target = join(DIR, "large.txt");
        const large = "x".repeat(200_000);
        writeAtomically(target, large);
        const read = readFileSync(target, "utf8");
        console.log(`  matches: ${read === large}`);
    }

    section("5. failure path — target's parent dir does not exist");
    {
        const target = join(DIR, "missing", "nested", "file.txt");
        try {
            writeAtomically(target, "should fail");
            console.log("  ✗ unexpectedly succeeded");
        } catch (error) {
            console.log(
                `  ✓ threw: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        console.log(`  .tmp files left: ${listTmpFiles().length} (expected 0)`);
        console.log(`  target exists:   ${existsSync(target)}`);
    }

    section("6. many writes to distinct files");
    {
        for (let i = 0; i < 10; i += 1) {
            writeAtomically(join(DIR, `f-${i}.txt`), `content ${i}`);
        }
        let allOk = true;
        for (let i = 0; i < 10; i += 1) {
            const content = readFileSync(join(DIR, `f-${i}.txt`), "utf8");
            if (content !== `content ${i}`) {
                allOk = false;
                break;
            }
        }
        console.log(`  all 10 files correct: ${allOk}`);
        console.log(`  .tmp files left: ${listTmpFiles().length} (expected 0)`);
    }

    section("notes");
    console.log("Multi-file atomicity (e.g. digest.json + digest.md together)");
    console.log("is not provided by this primitive alone. Each file is");
    console.log("individually atomic; a failure between the two writes leaves");
    console.log("one file written and one not. See notes-digest.ts for how the");
    console.log("workflows handle that case.");

    section("cleanup");
    rmSync(DIR, { recursive: true, force: true });
    console.log(`removed ${DIR}`);
}

main().catch((error) => {
    console.error(
        `error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
});