# tsagent

A TypeScript port of [`Gfinngh/agent`](https://github.com/Gfinngh/agent) — an
**event-sourced ReAct agent kernel** with tools, MCP integration, memory,
tracing, and opinionated workflows.

## Requirements

- **Node.js** ≥ 20.10
- **npm** (or compatible)
- Optional, only for specific features:
  - **Deno + Pyodide cache** — for the `execute_python` sandbox
  - **`GEMINI_API_KEY`** or **`GOOGLE_API_KEY`** — for real LLM runs
  - **`TAVILY_API_KEY`** — for `search_web`

## Quick start

```bash
npm install
cp .env.example .env
# Edit .env and set GEMINI_API_KEY (and optionally TAVILY_API_KEY)

# Sanity-check which models your key can reach:
npm run probe-models

# Run the CLI:
npm start -- "What's 2 + 3? Use the calculator tool."

# Run a workflow:
npx tsx src/workflows/research-brief.ts "The history of Rome"
```

## Architecture

The project is built around five primitives:

| Primitive | Module | Role |
|---|---|---|
| **Event-sourced conversation** | `src/agent/schemas.ts`, `context.ts`, `event-log.ts` | The `events` array *is* the conversation. Every event is appended to an optional JSONL log. `currentStep` and `finalResult` are derived, never persisted separately. |
| **Tool abstraction** | `src/agent/tools/base.ts` | `BaseTool` / `FunctionTool` / `RemoteTool` with permission tiers (`read` / `mutate` / `dangerous`), concurrency safety, per-tool timeouts, and multipart results. |
| **LLM client** | `src/agent/llm.ts`, `transport/google.ts` | A Vercel AI SDK wrapper with retries, error classification, deadlines, streaming, provider-option round-trip (Gemini thought signatures), tool-result normalization, and request capture. |
| **Agent loop** | `src/agent/agent.ts` | ReAct loop with permissions, concurrency, timeouts, structured output, and `resume()` for three interrupted states. |
| **MCP boundary** | `src/agent/client.ts`, `server.ts` | Stdio MCP client spawns a server subprocess, discovers tools, wraps them as `RemoteTool`. The server exposes calculator, greet, `search_web` (Tavily), workspace file tools, and the Deno/Pyodide `execute_python` sandbox. |

Supporting modules: `fallback.ts` (ordered LLM chain), `memory.ts` (SQLite +
FTS5), `tracing.ts` (OpenTelemetry facade, no-op when disabled), `signals.ts`
(abort helpers), `provider-options.ts` (signature round-trip).

## Commands

### CLI

```bash
npm start -- [--log <path>] [--resume] [--approve|--deny] [--allow-dangerous]
              [--model <name>] [--max-steps <n>] [--no-tracing] [<prompt>]
```

- `--log <path>` — write (fresh) or read (resume) the JSONL event log
- `--resume` — resume from `--log`
- `--approve` / `--deny` — mutually exclusive; auto-decide confirmations.
  Default (non-TTY) is deny.
- `--allow-dangerous` — unlock `dangerous` tools. Still requires a
  confirmation callback.

### Workflows

```bash
npx tsx src/workflows/research-brief.ts    "<topic>"
npx tsx src/workflows/iterative-brief.ts   "<topic>" [--refine "<text>"]
npx tsx src/workflows/notes-digest.ts      --notes-dir <dir> [--max-files N]
npx tsx src/workflows/trip-planner.ts      "<destination>" --days <N>
```

Each workflow writes per-run artifacts (`*.json`, `*.md`) and a `run.log.jsonl`
under its output directory, and cleans up on failure unless
`--keep-on-failure` is set.

### Probe models

```bash
npm run probe-models
# or, to probe specific models:
npx tsx probe-models.ts --model gemini-2.0-flash --model gemini-1.5-flash
```

Reports which models in the fallback chain respond with the current key.

## Verification

This project follows the source project's verification philosophy:

- **No test framework.** No Vitest, Jest, Mocha, or `*.test.ts` / `*.spec.ts`.
- **Standalone scripts** under `scripts/verify_<name>.ts`. Each is runnable
  individually (`npx tsx scripts/verify_<name>.ts` or `npm run verify:<name>`).
- **Real dependencies.** Real filesystems (temp dirs), real SQLite (temp
  `.sqlite3`), real MCP server subprocesses. Fake LLM clients only where the
  source project also uses them (`ScriptedClient`, `ScriptedTransport`).
- **Same assertions as the Python source.** Each `verify_*.ts` mirrors its
  Python counterpart.

Run everything:

```bash
npm run verify:all
```

Live-API tests (in `verify:stream`, `verify:stream-toolcall`,
`verify:provider-options-multiturn`, `verify:fallback-real`) skip cleanly when
`GEMINI_API_KEY` is not set. `verify:execute-python` skips when Deno is
unavailable.

## Project layout

```
main.ts                        CLI entry point
probe-models.ts                Model availability check
src/
  agent/
    schemas.ts                 zod schemas + inferred types
    context.ts                 ExecutionContext (event-sourced conversation)
    event-log.ts               JsonlEventLog + readEventLog
    llm.ts                     LlmClient, buildMessages, retry/classification
    transport/google.ts        Live Google transport
    provider-options.ts        Thought-signature helpers
    fallback.ts                FallbackClient + default policy
    agent.ts                   Agent loop, permissions, concurrency, resume
    client.ts                  McpConnection + mcpResultToMultipart
    server.ts                  MCP server (calculator, greet, files, sandbox)
    memory.ts                  MemoryStore (SQLite + FTS5)
    tracing.ts                 OpenTelemetry facade
    signals.ts                 Abort signal helpers
    tools/                     BaseTool, FunctionTool, RemoteTool, built-ins
  workflows/
    _shared.ts                 Shared helpers for workflows
    research-brief.ts
    iterative-brief.ts
    notes-digest.ts
    trip-planner.ts
scripts/                       verify_*.ts + _verify-common.ts
```

## Environment variables

Copy `.env.example` to `.env` and fill in what you need.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Google Gemini API access |
| `TSAGENT_MODEL` | Default model override |
| `TSAGENT_LOG_PATH` | Default log path for the CLI |
| `TSAGENT_MEMORY_DB` | Default SQLite path for `MemoryStore` |
| `TSAGENT_DENO_PATH` | Path to the Deno binary used by `execute_python` |
| `WORKSPACE_ROOT` | Root for the file tools (default: `process.cwd()`) |
| `MCP_SERVER_COMMAND` | Override the MCP server spawn command |
| `TAVILY_API_KEY` | Tavily access for `search_web` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP trace endpoint |
| `OTEL_EXPORTER_OTLP_HEADERS` | OTLP trace headers (`key=value,key=value`) |
| `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Langfuse via OTLP |

## Security model

The invariants below are enforced and verified:

- **Two-lock permission model.**
  - `read`: no callback needed.
  - `mutate`: requires a `confirmToolCall` callback. Denied without one.
  - `dangerous`: requires both `allowDangerous: true` *and* a callback
    returning true. The callback is not consulted if `allowDangerous` is
    false.
- **Denied calls become error `ToolResult`s**, never exceptions. The denied
  tool is never invoked.
- **Workspace confinement** for `list_files` / `read_file` / `write_file`:
  absolute paths, `..` traversal, and any path resolving outside the
  workspace root are rejected.
- **Sandbox**: `execute_python` runs Python under Deno + Pyodide with
  `--cached-only --allow-read=<npm_cache>` only. No network, no environment,
  no subprocess, no filesystem writes. 16 KiB output cap, 1–30 s timeout.
- **Approvals default to deny** when stdin is not a TTY. The CLI prints an
  explicit message so non-interactive environments (codeserver tasks, CI)
  explain the behavior instead of silently failing.

## License

Same as the source project.