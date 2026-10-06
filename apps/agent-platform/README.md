# agent-platform

A learning project: an agent runtime built without an agent framework, so the
agent loop, the tool trust boundary, and the provider abstraction are all
visible in our own code.

**Status: Review Checkpoint #1 — skeleton.** The service accepts messages per
conversation and replies through a placeholder LLM boundary backed by a
deterministic stub. No real LLM, tools, MCP, tasks, or voice yet.

## Run it

Requires Node.js >= 22.18 (runs TypeScript directly via built-in type stripping).

```sh
npm install
npm run dev          # node --watch src/main.ts, pretty logs in a terminal
npm test             # node:test, no test framework dependency
npm run typecheck
```

Or with Docker:

```sh
docker compose up --build
```

Then:

```sh
curl -s -X POST localhost:3000/messages \
  -H 'content-type: application/json' \
  -d '{"conversationId":"test-1","message":"Hello"}'
# {"conversationId":"test-1","turnId":"…","reply":"[stub] You said: \"Hello\" (context: 1 messages)"}
```

Send a second message with the same `conversationId` and the stub reports
`context: 3 messages`, so history is being kept.

| Env var      | Default                       | Values                         |
| ------------ | ----------------------------- | ------------------------------ |
| `PORT`       | `3000`                        | 1-65535                        |
| `LOG_LEVEL`  | `info`                        | `debug` `info` `warn` `error`  |
| `LOG_FORMAT` | `pretty` on a TTY, else `json`| `pretty` `json`                |

## Layout and dependency direction

```
src/
  main.ts                       composition root: the only place concrete classes are chosen
  config.ts                     env vars -> typed config, fail fast
  logger.ts                     structured logger (event name + fields)
  http/server.ts                HTTP transport adapter (node:http)
  runtime/agent-runtime.ts      runTurn(): orchestrates one conversational turn
  conversation/
    conversation-store.ts       persistence interface (async, append-only)
    in-memory-conversation-store.ts
  llm/
    llm-provider.ts             LLM boundary (placeholder contract)
    stub-llm-provider.ts        deterministic fake provider
  core/messages.ts              provider-neutral message types
```

```
http ──► runtime ──► LLMProvider (interface)
              └────► ConversationStore (interface)
everything ──► core/messages
main.ts wires the concrete implementations together
```

Nothing below `http/` knows about HTTP. A future CLI, WebSocket, or voice
layer calls the same `runtime.runTurn({ conversationId, text })`.

## Log events

Every line has an `event` name. Lines inside a turn carry `conversationId` and
`turnId`.

| Event            | Meaning                                        |
| ---------------- | ---------------------------------------------- |
| `user.message`   | turn started with this user input              |
| `llm.request`    | runtime is calling the provider                |
| `llm.response`   | provider answered (with `durationMs`)          |
| `final.response` | turn finished; reply returned to the caller    |
| `turn.failed`    | turn aborted; history left unchanged           |
| `http.rejected`  | 4xx: client input refused at the transport     |
| `http.error`     | 5xx: unexpected error (details only in logs)   |

## Known limitations (intentional for now)

- Conversation state is in memory: lost on restart, so run a single instance.
- Two concurrent turns on the same `conversationId` are not serialized; both
  read the same history. This gets solved deliberately alongside the async
  task model, because "what happens when a message arrives mid-turn" is the
  same problem.
- The LLM interface is a placeholder. It gets designed properly (tools, stop
  reasons, usage, cancellation) before we integrate a real provider.
