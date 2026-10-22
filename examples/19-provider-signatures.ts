/**
 * 19 — Provider thought signatures
 *
 * Gemini 3.x attaches a `thoughtSignature` to every function call; the
 * signature must be echoed back on the next turn or the model rejects
 * the request. Internally we store the signature under the snake_case
 * key `thought_signature` (matching the Python source), while the AI
 * SDK expects camelCase `thoughtSignature`. The helpers in
 * `provider-options.ts` translate between the two and detect a
 * LiteLLM sentinel value that is *not* a real signature.
 *
 * This example shows the helpers in isolation. No LLM, no transport,
 * no network.
 *
 *   npx tsx examples/19-provider-signatures.ts
 */

import {
    DUMMY_SIGNATURE_KEY,
    THOUGHT_ID_SUFFIX,
    THOUGHT_SIGNATURE_KEY,
    decodeThoughtId,
    encodeThoughtId,
    extractThoughtSignature,
    isDummySignature,
    unwrapLegacyProviderFields,
    withThoughtSignature,
} from "../src/agent/provider-options.js";
import { section } from "./_common.js";

function main(): void {
    section("1. extractThoughtSignature");
    console.log(
        `  {${THOUGHT_SIGNATURE_KEY}: "sig"}: ` +
        extractThoughtSignature({ [THOUGHT_SIGNATURE_KEY]: "sig" }),
    );
    console.log(
        `  {"thoughtSignature": "sig"}:     ` +
        extractThoughtSignature({ thoughtSignature: "sig" }),
    );
    console.log(
        `  legacy {"google": {"...": "sig"}}: ` +
        extractThoughtSignature({ google: { [THOUGHT_SIGNATURE_KEY]: "sig" } }),
    );
    console.log(
        `  dummy sentinel:                  ` +
        extractThoughtSignature({ [DUMMY_SIGNATURE_KEY]: true }),
    );
    console.log(`  null:                            ${extractThoughtSignature(null)}`);

    section("2. isDummySignature");
    for (const value of [DUMMY_SIGNATURE_KEY, true, "real", 42, null]) {
        console.log(`  ${String(value).padEnd(35)} → ${isDummySignature(value)}`);
    }

    section("3. unwrapLegacyProviderFields");
    console.log(
        `  {"google": {"a":1}}: ${JSON.stringify(unwrapLegacyProviderFields({ google: { a: 1 } }))}`,
    );
    console.log(
        `  {"a":1}:             ${JSON.stringify(unwrapLegacyProviderFields({ a: 1 }))}`,
    );
    console.log(
        `  {"google":1,"b":2}:  ${JSON.stringify(unwrapLegacyProviderFields({ google: 1, b: 2 }))}`,
    );

    section("4. withThoughtSignature");
    console.log(
        `  from null:        ${JSON.stringify(withThoughtSignature(null, "sig"))}`,
    );
    console.log(
        `  over {other:1}:   ${JSON.stringify(withThoughtSignature({ other: 1 }, "sig"))}`,
    );
    console.log(
        `  legacy unwrapped: ${JSON.stringify(withThoughtSignature({ google: { old: "x" } }, "sig"))}`,
    );

    section("5. thought-id encoding");
    const base = "call_abc";
    const sig = "sig_xyz";
    const encoded = encodeThoughtId(base, sig);
    console.log(`  encode("${base}", "${sig}")`);
    console.log(`    → ${encoded}`);
    const decoded = decodeThoughtId(encoded);
    console.log(`  decode("${encoded}")`);
    console.log(`    → ${JSON.stringify(decoded)}`);
    console.log(`  suffix used internally: "${THOUGHT_ID_SUFFIX}"`);
    console.log(`  decode("plain"): ${JSON.stringify(decodeThoughtId("plain"))}`);

    section("notes");
    console.log("You never call these helpers directly in normal use —");
    console.log("the transport (src/agent/transport/google.ts) invokes them.");
    console.log(
        "They are public because verification scripts and diagnostic tools",
    );
    console.log("need to inspect the round-trip contract.");
}

main();