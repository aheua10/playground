# agent-platform

A learning project: an agent runtime built without an agent framework, so the
agent loop, the tool trust boundary, and the provider abstraction are all
visible in our own code.

**Status: Phase 1 complete.** Conversations over HTTP, an explicit agent loop,
one native tool (`get_current_time`) behind a trust boundary, and two LLM
providers: a deterministic stub (default, no API key) and Anthropic (Claude).
Not yet: async tasks, MCP, persistence, voice.

## Run it

Requires Node.js >= 22.18 (runs TypeScript directly via built-in type stripping).

```sh
npm install
cp .env.example .env   # optional: pick the LLM provider here
npm run dev            # node --watch, pretty logs in a terminal
npm test               # node:test, no test framework dependency
npm run typecheck
```

Or with Docker (reads the same `.env`):

```sh
docker compose up --build
```

Then ask something that needs the tool:

```sh
curl -s -X POST localhost:3000/messages \
  -H 'content-type: application/json' \
  -d '{"conversationId":"demo","message":"What time is it in Asia/Tokyo?"}'

curl -s localhost:3000/conversations/demo   # the stored turn: user, tool call, tool result, reply
```

With the stub, any message containing "time" triggers the tool, so the whole
loop runs without an API key. For a real model set `LLM_PROVIDER=anthropic`
and `ANTHROPIC_API_KEY` in `.env`.

| Env var             | Default                        | Values                                  |
| ------------------- | ------------------------------ | --------------------------------------- |
| `LLM_PROVIDER`      | `stub`                         | `stub` `anthropic`                      |
| `ANTHROPIC_API_KEY` | (required for `anthropic`)     |                                         |
| `ANTHROPIC_MODEL`   | `claude-opus-5-5`              | any Claude model id                     |
| `ANTHROPIC_EFFORT`  | `medium`                       | `low` `medium` `high` `xhigh` `max`     |
| `PORT`              | `3000`                         | 1-65535                                 |
| `LOG_LEVEL`         | `info`                         | `debug` `info` `warn` `error`           |
| `LOG_FORMAT`        | `pretty` on a TTY, else `json` | `pretty` `json`                         |

`LOG_LEVEL=debug` also logs the full payload of every LLM request (system
prompt, tool definitions, messages): exactly what the model is told.

## HTTP API

| Route                     | Purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `POST /messages`          | `{ conversationId, message }` → `{ conversationId, turnId, reply }` |
| `GET /conversations/:id`  | stored history, including tool calls and results (debugging)   |
| `GET /health`             | liveness check                                                 |

If the client disconnects mid-turn, the turn is cancelled (LLM call and tools
aborted) and nothing is persisted.

## The agent loop

`AgentRuntime.runTurn()` in `src/runtime/agent-runtime.ts`:

```
user message
  └─► LLM call (history + tool definitions)
        ├─ no tool calls ─► final reply, persist the whole turn, return
        └─ tool calls ────► ToolExecutor, one call at a time
                               └─ append results, loop (at most 8 LLM calls)
```

The LLM decides what it wants; the runtime controls whether and how it
happens. Every tool call passes `ToolExecutor` (`src/tools/tool-executor.ts`),
the trust boundary:

1. **exists**: only registered tools run, so the model can't invent capabilities
2. **permitted**: policy hook (Phase 1: all tools are read-only, so all allowed)
3. **valid**: input must match the tool's JSON Schema (ajv, compiled at startup)
4. **bounded**: timeout plus the turn's cancellation signal

Rejections and failures go back to the model as error results it can react to.
Only unexpected exceptions are hidden from it (details go to the logs).

## Layout and dependency direction

```
src/
  main.ts                    composition root: the only place concrete classes are chosen
  config.ts                  env vars -> typed config, fail fast
  logger.ts                  structured logger (event name + fields)
  http/server.ts             HTTP transport adapter (node:http)
  runtime/
    agent-runtime.ts         the agent loop
    system-prompt.ts         static on purpose (prompt caching, thinking replay)
  tools/
    tool.ts                  Tool contract + ToolError
    tool-registry.ts         which tools exist; schema compilation
    tool-executor.ts         the trust boundary
    get-current-time.ts      first native tool
  llm/
    llm-provider.ts          the provider boundary
    anthropic-provider.ts    Claude via the Anthropic SDK (the only file that knows its format)
    stub-llm-provider.ts     deterministic fake that speaks tool calls
  conversation/              async, append-only store interface + in-memory impl
  core/                      provider-neutral messages and tool definitions
```

```
http ──► runtime ──► LLMProvider (interface)      ◄── anthropic, stub
              ├────► ToolExecutor ──► ToolRegistry ◄── native tools (later: MCP tools)
              └────► ConversationStore (interface) ◄── in-memory
everything ──► core/
```

## Log events

Lines inside a turn carry `conversationId`, `turnId` and, inside the loop, `step`.
Tool lines add `toolCallId` and `tool`.

| Event                 | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `user.message`        | turn started                                               |
| `llm.request`         | runtime calls the provider (message count, offered tools)  |
| `llm.request.payload` | debug only: the full request                               |
| `llm.response`        | text, tool calls, stop reason, token usage, model, latency |
| `tool.request`        | the model asked for a tool (untrusted input)               |
| `tool.rejected`       | refused at the trust boundary (unknown tool, invalid input)|
| `tool.execution`      | passed all gates, now running                              |
| `tool.result`         | outcome sent back to the model                             |
| `tool.error`          | unexpected tool exception (details not shown to the model) |
| `final.response`      | turn finished                                              |
| `turn.failed`         | turn aborted; history unchanged                            |
| `turn.cancelled`      | caller cancelled (e.g. client disconnected)                |
| `http.rejected`       | 4xx: client input refused at the transport                 |
| `http.error`          | 5xx: unexpected error (details only in logs)               |

## Design notes

- **Messages are provider-neutral, with one escape hatch.** Assistant messages
  carry `raw`, the provider's exact wire form, replayed verbatim to the same
  provider. Anthropic's thinking blocks are signed and must come back
  unchanged; rebuilding them from neutral fields would break the next request.
- **The prompt prefix must stay stable.** The system prompt is static, the
  tool list is sorted, and history is append-only. That keeps prompt caching
  effective and satisfies Anthropic's check that the history before a
  thinking block is unchanged. Dynamic facts like the time come from tools.
- **Turns are all-or-nothing.** A failed or cancelled turn persists nothing.
  Tool side effects are not rolled back, so the `tool.*` logs are the audit trail.

## Known limitations (intentional for now)

- Conversation state is in memory: lost on restart, so run a single instance.
- Two concurrent turns on the same `conversationId` are not serialized. This
  gets solved together with the async task model, since "a message arrives
  mid-turn" is the same problem.
- Responses are not streamed (needed later for voice).
- A tool that ignores its abort signal keeps running after a timeout; the
  runtime just stops waiting. Real isolation (separate process/container)
  comes with tools that execute code.
