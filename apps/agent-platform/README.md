# agent-platform

A learning project: an agent runtime built without an agent framework, so the
agent loop, the tool trust boundary, and the provider abstraction are all
visible in our own code.

**Status: Phase 2 complete.**
- **Phase 1:** conversations over HTTP, an explicit agent loop, a native tool
  (`get_current_time`) behind a trust boundary, and two LLM providers: a
  deterministic stub (default, no API key) and Anthropic (Claude).
- **Phase 2:** background tasks the conversation can start, inspect, revise and
  cancel while it carries on. The worker is simulated for now.

Not yet: a real coding worker (needs sandboxing), MCP, persistence, realtime/voice.

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

Then talk to it:

```sh
say() { curl -s -X POST localhost:3000/messages -H 'content-type: application/json' \
          -d "{\"conversationId\":\"demo\",\"message\":\"$1\"}"; echo; }

say "What time is it in Asia/Tokyo?"
say "Create a TypeScript server for this project."   # returns at once: task started
say "Use Fastify instead of Express."                # revises the running task
say "What is the status?"
curl -s localhost:3000/conversations/demo/tasks      # watch progress; done after ~12 s
curl -s localhost:3000/conversations/demo            # the stored turns, with tool calls and results
```

The stub picks tools by keyword (`time`; `create/build/write/...`; `instead/also/add/change`;
`status/done`; `cancel/stop`), so all of this works without an API key. For a
real model set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `.env`.

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
| `GET /conversations/:id/tasks` | the conversation's background tasks and their state       |
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
2. **permitted**: policy hook. No general policy yet: the only side effects are
   task start/revise/cancel, scoped to the calling conversation by `TaskManager`
3. **valid**: input must match the tool's JSON Schema (ajv, compiled at startup)
4. **bounded**: timeout plus the turn's cancellation signal

Rejections and failures go back to the model as error results it can react to.
Only unexpected exceptions are hidden from it (details go to the logs).

Turns are serialized per conversation: a message that arrives mid-turn waits
(`turn.waiting`) and then sees the finished turn. Other conversations run in
parallel. (Voice will later want "interrupt" instead of "queue"; that is a
policy change in one place.)

## Background tasks

Work that takes longer than a turn runs as a task (`src/tasks/`). The agent
drives tasks through five tools:

| Tool                | Does                                                         |
| ------------------- | ------------------------------------------------------------ |
| `start_coding_task` | creates a task and returns `{ taskId, status: "running" }` at once |
| `get_task`          | status, progress, result/error                               |
| `list_tasks`        | all tasks in this conversation                               |
| `revise_task`       | adds/changes a requirement; restarts the task as a new attempt |
| `cancel_task`       | stops a running task for good                                |

| From                  | To                                                          |
| --------------------- | ----------------------------------------------------------- |
| (start)               | `running` (attempt 1)                                       |
| `running`             | `completed`, `failed`, `cancelled`, or `running` again via revise (new attempt) |
| `completed`, `failed` | `running` via revise (new attempt)                          |
| `cancelled`           | nothing: final                                              |

- **`TaskManager` owns the lifecycle.** Every change goes through it, under a
  per-task lock. Each revision starts a new *attempt*; an older attempt that
  finishes late is ignored (`task.stale_update_dropped`), so "use Fastify"
  can't be overwritten by the Express run that was still going.
- **Tasks belong to a conversation.** The task tools take the conversation id
  from the runtime, never from the model's input, so a model or a prompt
  injection can only reach its own conversation's tasks. Unknown and foreign
  task ids get the same "no task" answer.
- **Limits.** At most 3 running tasks per conversation.
- **The worker is pluggable** (`TaskWorker`). `SimulatedCodingWorker` reports
  progress over ~12 s and returns a description of what it would build. A
  real coding worker executes model-written code, so it waits for the
  sandbox/permissions design.
- **Pull, not push (for now).** The agent learns about progress when it calls
  `get_task`/`list_tasks`, e.g. because the user asks. Telling the user
  unprompted ("your server is ready") needs a realtime channel, which comes
  with WebSockets/voice.

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
  tasks/
    task.ts                  Task type and allowed status transitions
    task-manager.ts          lifecycle: start, revise, cancel, attempts, ownership
    task-worker.ts           TaskWorker contract
    simulated-coding-worker.ts  stand-in worker (no code is written)
    task-store.ts            async store interface + in-memory impl
    task-tools.ts            the five tools the agent uses to drive tasks
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
  core/                      provider-neutral messages, tool definitions, KeyedMutex
```

```
http ──► runtime ──► LLMProvider (interface)      ◄── anthropic, stub
              ├────► ToolExecutor ──► ToolRegistry ◄── native tools, task tools (later: MCP tools)
              │                                          └─► TaskManager ──► TaskWorker, TaskStore
              └────► ConversationStore (interface) ◄── in-memory
everything ──► core/
```

## Log events

Lines inside a turn carry `conversationId`, `turnId` and, inside the loop, `step`.
Tool lines add `toolCallId` and `tool`; task lines carry `conversationId`,
`taskId` and `attempt`.

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
| `turn.waiting`        | another turn in this conversation is running; queued       |
| `task.started`        | task created, attempt 1 launched                           |
| `task.progress`       | worker progress note                                       |
| `task.revised`        | requirement added; new attempt launched                    |
| `task.completed`      | worker finished; result stored                             |
| `task.failed`         | worker failed, or interrupted by shutdown                  |
| `task.cancelled`      | stopped on request                                         |
| `task.stale_update_dropped` | debug: late result from a superseded attempt ignored |
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

- Conversations and tasks are in memory: lost on restart, so run a single
  instance. On SIGTERM, running tasks are recorded as interrupted first.
- Task work runs inside the server process. At scale it moves to a queue and
  separate workers; `TaskManager` keeps its interface.
- Task updates are pull-only (see Background tasks).
- Responses are not streamed (needed later for voice).
- A tool that ignores its abort signal keeps running after a timeout; the
  runtime just stops waiting. Real isolation (separate process/container)
  comes with tools that execute code.
