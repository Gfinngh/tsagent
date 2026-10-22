# AGENTS.md

Orientation for an LLM reading this repository to generate study material,
handbook chapters, or guided walkthroughs.

## What this project is

A TypeScript port of an event-sourced ReAct agent kernel. Five primitives
form the kernel, all under `src/agent/`:

1. **Event-sourced conversation** — `schemas.ts`, `context.ts`, `event-log.ts`.
   The `events` array on `ExecutionContext` *is* the conversation; there is
   no parallel message history. `currentStep` and `finalResult` are derived
   from `events`, never persisted separately.

2. **Tool abstraction** — `tools/base.ts`. `BaseTool` → `FunctionTool`
   (typed function) and `RemoteTool` (MCP callback). Three permission tiers:
   `read` (no callback), `mutate` (requires `confirmToolCall`), `dangerous`
   (requires both `allowDangerous: true` *and* a callback returning true).

3. **LLM client** — `llm.ts`, `transport/google.ts`, `prompt-cache.ts`,
   `provider-options.ts`. Retry, error classification, streaming, prompt
   building, tool-result normalization, Gemini thought-signature round-trip.

4. **Agent loop** — `agent.ts`. `Agent.run` and `Agent.resume`. Permissions,
   concurrency batching, per-tool timeouts, structured output via
   `final_answer`, resume-from-three-states.

5. **MCP boundary** — `client.ts`, `server.ts`. `McpConnection` owns a stdio
   subprocess; `loadMcpTools` wraps each tool as a `RemoteTool`;
   `mcpResultToMultipart` converts MCP content blocks to our multipart type.

Everything else — `memory.ts`, `tracing.ts`, `fallback.ts`, `models.ts`,
`signals.ts`, `runtime.ts`, `workflows/` — is built on those five.

## Where to start reading

- **`examples/README.md`** — coverage map: every core part of the project
  mapped to the example(s) that demonstrate it. The natural chapter list
  for a handbook.
- **Real-LLM examples** — `01`–`06` and `09`. Use these for chapters about
  what an agent run looks like end-to-end against a real model. They
  consume quota; use sparingly when generating study material.
- **Local-only examples** — `07` (MCP subprocess, no LLM), `08` (memory
  store, no LLM), and `10`–`25` (scripted client or pure local). Use these
  for study because their output is identical on every run and they consume
  no quota.
- **`scripts/verify_*.ts`** — executable specifications. The `check(…)`
  calls inside each file are the actual behavioral contract. Reading a
  `verify_*.ts` alongside its source module is the fastest path to
  understanding a primitive.

## Invariants that must not be broken

These are load-bearing. Every verification script asserts at least one.

- **Two-lock permission model.** `read` always runs. `mutate` requires a
  `confirmToolCall` callback; denied without one. `dangerous` requires
  `allowDangerous: true` **and** a callback returning true; the callback is
  not consulted when `allowDangerous` is false.
- **Denied calls become error `ToolResult`s**, never exceptions. The denied
  tool is never invoked.
- **`ExecutionContext.events` is the conversation.** Derive, don't cache.
- **`currentStep` counts events that carry an assistant message or tool
  call.** A tool-result event does not count separately.
- **`finalResult` requires `outputToolName` for structured runs.** Without
  it, a structured run whose last event is a `final_answer` tool result looks
  unfinished — this is deliberate, it is what makes `fromLog` correctly
  detect the finished state.
- **Workspace file tools reject absolute paths, `..` segments, and symlinks
  that resolve outside the root.** Lexical and realpath checks both run.
- **`execute_python` runs with no network, no env, no filesystem writes.**
  The Deno child gets only `DENO_DIR`, `HOME`, `PATH`, `TMPDIR`, and platform
  lib paths.
- **MCP `_meta.permission` is honored only when `connection.trusted === true`.**
  Untrusted servers' self-reported permissions are ignored; unoverridden
  tools default to `dangerous`.

## Conventions

- **No test framework.** Verification lives in `scripts/verify_*.ts`, run via
  `npm run verify:<name>` or `npx tsx scripts/verify_<name>.ts`. Each is a
  standalone executable specification.
- **Every module has a matching verification script.** If you add a
  primitive, add its `verify_*.ts` in the same step.
- **`scripts/_verify-common.ts`** provides `check`, `checkEqual`, `skip`,
  `makeTempDir`, `runScript`. No `console.*` — direct `process.stdout.write`
  / `process.stderr.write`.
- **Two error-message styles, both intentional:**
  - `ToolResult.content` (shown to the model): `<subject> <problem>[: <detail>]`.
  - CLI stderr (shown to the operator): `[tsagent] <summary>`.

  Do not normalize these across audiences.
- **Examples are demos, not tests.** They are excluded from `verify:all`.
  `tsc --noEmit` covers them (they are in `tsconfig.include`).

## Schema evolution

The event log schema is versioned by additive change:

- `ToolResult.errorKind` was introduced in a later delivery with
  `.nullable().default(null)`, so event logs written before it still parse.
- New fields on `ToolCall`, `ToolResult`, `Message`, and `AgentEvent` should
  follow the same pattern — `.default(...)` or `.nullable().default(null)`,
  never a required field that would reject old logs.

Event log files are durable user data (resume, workflow artifacts). They
are not throwaway caches. Any schema change must be able to read existing
logs.

## Layout

| Path | Contents |
|---|---|
| `src/agent/` | Kernel. `schemas.ts`, `context.ts`, `event-log.ts`, `llm.ts`, `agent.ts`, `client.ts`, `server.ts`, `memory.ts`, `tracing.ts`, `fallback.ts`, `models.ts`, `signals.ts`, `runtime.ts`, `prompt-cache.ts`, `provider-options.ts`, `transport/google.ts`, `tools/` |
| `src/workflows/` | Opinionated orchestrators: `research-brief.ts`, `iterative-brief.ts`, `notes-digest.ts`, `trip-planner.ts`, plus `_shared.ts` and `index.ts` |
| `scripts/` | `verify_*.ts` (executable specification) and `_verify-common.ts` |
| `examples/` | 25 runnable demos, plus `_common.ts` and `_fakes.ts` |
| `main.ts` | CLI entry point |
| `probe-models.ts` | Model availability probe |

## What this project deliberately does not have

- **A test framework.** No Jest, Vitest, Mocha, `*.test.ts`, `*.spec.ts`.
- **CI workflows.** Verification requires `GEMINI_API_KEY`; CI would need
  secrets that are out of scope for an educational repo.
- **A build step for verification.** Verification runs via `tsx` directly
  against `.ts` files. There is no compilation step.