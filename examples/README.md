# Examples

Runnable, self-contained demonstrations of what `tsagent` can do. Each
file shows one capability and prints human-readable output so you can
see exactly what happened.

These are **not** tests. For the verification suite, see
`scripts/verify_*.ts` and `npm run verify:all`.

## Prerequisites

```bash
cp .env.example .env
# edit .env — set GEMINI_API_KEY (or GOOGLE_API_KEY)
npm install
```

Run any example with `npx tsx`:

```bash
npx tsx examples/01-hello-world.ts
```

## Which examples need what

- **Real LLM** (`GEMINI_API_KEY` or `GOOGLE_API_KEY`) — `01`–`06`, `09`.
  These call Gemini and consume quota.
- **No LLM** — `07`, `08`, `10`–`25`. These use either a scripted
  `ScriptedClient` from `_fakes.ts` (so the agent-loop mechanics are
  visible and deterministic) or a real local primitive (MCP subprocess,
  SQLite, OpenTelemetry, filesystem).
- **Deno** (`TSAGENT_DENO_PATH`, or `deno` on `PATH`) — `15` only.
  Skips cleanly if Deno is not installed.

The MCP-based examples (`07`, `13`) spawn a real subprocess; neither
calls `search_web`, so no `TAVILY_API_KEY` is required.

## Coverage map

Every core part of the project is demonstrated by at least one example.
Use this as the chapter list for a handbook: read the source module
alongside its example.

### Event-sourced conversation

The `events` array on `ExecutionContext` *is* the conversation;
`currentStep` and `finalResult` are derived, never persisted separately.
Events are appended to a JSONL log and can be rehydrated.

- **`05-resume-conversation.ts`** — run, append events to
  `JsonlEventLog`, rehydrate via `ExecutionContext.fromLog`, resume
  with a follow-up message. Shows that the resumed run sees the entire
  prior conversation.
- **`16-event-log.ts`** — the log primitive in isolation: basic
  round-trip, blank lines, truncated tail, malformed interior line,
  reopen-after-close, and memory-bounded reading.

Source: `src/agent/schemas.ts`, `src/agent/context.ts`,
`src/agent/event-log.ts`.

### Tool abstraction

`BaseTool` → `FunctionTool` (typed function, zod schema) and
`RemoteTool` (MCP callback, raw input schema). Three permission tiers,
concurrency safety, per-tool timeouts, multipart results.

- **`02-tool-calling.ts`** — one tool, full tool-call round trip
  (model → tool → result → model).
- **`03-multi-tool.ts`** — shipped tools plus a custom `FunctionTool`
  built from a zod schema.
- **`07-mcp-tools.ts`** — `loadMcpTools` wraps each MCP tool as a
  `RemoteTool`; call them directly, without an LLM in the loop.
- **`10-permissions.ts`** — the two-lock permission model: `read` runs,
  `mutate` requires a `confirmToolCall` callback, `dangerous` requires
  both `allowDangerous` and a callback returning true.
- **`11-tool-timeouts.ts`** — a per-tool `timeoutMs` produces a
  `ToolResult` with `errorKind: "timeout"`; the run continues and the
  model can react.
- **`12-parallel-tool-calls.ts`** — concurrency batching: an all-read
  batch runs in parallel, one non-safe tool forces the whole batch
  sequential, results preserve emission order.
- **`14-mcp-file-tools.ts`** — `list_files` / `read_file` /
  `write_file` confined to a `workspaceRoot`; absolute paths, `..`
  traversal, and escaping symlinks are rejected before any filesystem
  access happens.

Source: `src/agent/tools/base.ts`, `src/agent/tools/multipart.ts`,
`src/agent/tools/{add,greet,calculator,workspace}.ts`,
`src/agent/agent.ts` (permissions, concurrency, timeouts).

### LLM client

`LlmClient` wraps a `Transport` with retry, error classification,
deadlines, streaming, and request capture. `buildMessages` turns events
into `ChatMessage[]`; `PromptCache` extends that incrementally.

- **`01-hello-world.ts`** — the smallest agent: one user message, one
  text response, no tools.
- **`06-streaming.ts`** — incremental text delivery via `onTextDelta`,
  driving `LlmClient` directly (transport-level).
- **`09-fallback.ts`** — `FallbackClient` rotates on retryable
  failures and reports `fallbackUsed`, `fallbackFrom`,
  `fallbackLandedOn`, `fallbackTried`.
- **`18-retry-and-classification.ts`** — `classifyError` taxonomy,
  `computeBackoff`, and a live retry loop against a flaky transport.
- **`19-provider-signatures.ts`** — Gemini thought signatures:
  extract, encode/decode the `__thought__` id suffix, detect the dummy
  sentinel.
- **`20-models-api.ts`** — `getModelChain` under `test` vs `prod`
  order; `resolveModel` strips provider prefixes.
- **`24-prompt-cache.ts`** — `PromptCache` incremental build, and the
  "old snapshots are not mutated" invariant.

Source: `src/agent/llm.ts`, `src/agent/transport/google.ts`,
`src/agent/prompt-cache.ts`, `src/agent/provider-options.ts`,
`src/agent/fallback.ts`, `src/agent/models.ts`.

### Agent loop

`Agent.run` and `Agent.resume`: the ReAct loop, structured output,
permissions, concurrency, timeouts, resume-from-three-states.

- **`01`–`03`** — the basic loop: text response, one tool, multiple
  tools in one run.
- **`04-structured-output.ts`** — `outputType` injects a
  `final_answer` tool and forces `toolChoice: "required"`; the result
  is a validated object.
- **`17-tracing.ts`** — the span tree emitted on every run
  (`agent.run` → `agent.step` → `agent.tool`), read back via
  `inMemorySpans`.
- **`10`–`12`** — permissions, per-tool timeouts, and concurrency
  batching (also listed under Tool abstraction).

Source: `src/agent/agent.ts`, `src/agent/context.ts`.

### MCP boundary

`McpConnection` owns a stdio subprocess; `loadMcpTools` wraps its
tools; `mcpResultToMultipart` converts MCP content blocks to our
multipart type. Trust is explicit: a server we spawn ourselves is
trusted; a command from `MCP_SERVER_COMMAND` is not.

- **`07-mcp-tools.ts`** — spawn, discover, call tools directly.
- **`13-mcp-trust-boundary.ts`** — `_meta.permission` is honored on a
  trusted connection, ignored on an untrusted one (defaulting to
  `dangerous`), and explicit overrides win either way.

Source: `src/agent/client.ts`, `src/agent/server.ts`,
`src/agent/runtime.ts` (`spawnMcpConnection`).

### Memory

SQLite + FTS5 key/value store with keyword search, size bounds, and
pruning. Four `makeMemoryTools` wrappers give the agent
`remember`/`recall`/`forget`/`list_memories`.

- **`08-memory.ts`** — `upsert`, `search`, `list`, `forget`, and the
  tool set.
- **`21-memory-bounds.ts`** — hard caps on key/content/tags, `prune(N)`,
  auto-prune on open via `TSAGENT_MEMORY_PRUNE_DAYS`, `sizeBytes`.

Source: `src/agent/memory.ts`.

### Tracing

OpenTelemetry facade. Off by default; `initTracing()` turns it on;
`inMemorySpans()` exposes the buffer; OTLP / Langfuse export is driven
by env vars.

- **`17-tracing.ts`** — span tree, events, status, and shutdown.

Source: `src/agent/tracing.ts`.

### Reliability primitives

- **`22-atomic-writes.ts`** — `writeAtomically`: temp file + `fsync` +
  `rename`, never a partial file, no leftover `.tmp`.
- **`23-abort-signals.ts`** — `mergeSignals`, `makeAbortError`,
  `isAbortError`, and abort propagation through an awaited tool.

Source: `src/workflows/_shared.ts` (`writeAtomically`),
`src/agent/signals.ts`.

### Sandbox

- **`15-execute-python.ts`** — `execute_python` runs Python under
  Deno + Pyodide with no network, no env, no filesystem writes.
  `permission: "dangerous"` — the two-lock model applies on top.
  Requires Deno; skips cleanly otherwise.

Source: `src/agent/tools/python.ts`.

### CLI

- **`25-cli-modes.ts`** — `main.ts --help`, the common invocations,
  the environment variables that affect the CLI, and the exit codes
  (`0` success, `1` LLM/MCP failure, `2` usage, `3` quota, `130`
  interrupted).

Source: `main.ts`.

## Helpers

- **`_common.ts`** — env loading, directory setup, trace printing,
  final-result printing, tool-result collection.
- **`_fakes.ts`** — a `ScriptedClient` for examples that need
  deterministic agent-loop mechanics without spending quota. Distinct
  from `scripts/_verify-agent.ts`'s `ScriptedClient`; the two are
  intentionally separate so the examples one can evolve independently.
