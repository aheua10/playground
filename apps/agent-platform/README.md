# agent-platform

A learning project: an agent runtime built without an agent framework, so the
agent loop, the tool trust boundary, and the provider abstraction are all
visible in our own code.

**Status: Phase 5 complete, plus authentication.**
- **Phase 1:** conversations over HTTP, an explicit agent loop, a native tool
  (`get_current_time`) behind a trust boundary, and two LLM providers: a
  deterministic stub (default, no API key) and Anthropic (Claude).
- **Phase 2:** background tasks the conversation can start, inspect, revise and
  cancel while it carries on.
- **Phase 3:** the coding worker, a second agent that writes code in a
  per-task workspace and runs commands in locked-down Docker containers.
- **Phase 4:** tasks can work on an existing repository: a checkout on a
  task branch, committed for the worker, and pushed on request.
- **Phase 5:** a realtime channel. A WebSocket streams replies, tool calls
  and task updates as they happen, and the agent speaks up on its own when a
  task finishes.
- **Authentication:** bearer tokens per user, and conversations (with their
  tasks) private to their user.

Not yet: MCP, persistence, voice. Deploying: see
[DEPLOY.md](DEPLOY.md).

## Run it

Requires Node.js >= 22.18 (runs TypeScript directly via built-in type stripping).

```sh
npm install
cp .env.example .env              # pick the LLM provider etc. here
npm run create-token -- me        # prints a token, and an AUTH_TOKENS=... line for .env
#   put the AUTH_TOKENS line in .env, and keep the token for yourself:
export AGENT_TOKEN=ap_...
npm run dev                       # node --watch, pretty logs in a terminal
npm test                          # node:test, no test framework dependency
npm run typecheck
```

Without `AUTH_TOKENS` the server refuses to start. On a machine only you can
reach, `AUTH=none` in `.env` switches authentication off instead.

Or with Docker (reads the same `.env`):

```sh
docker compose up --build
```

Then talk to it:

```sh
api() { curl -s -H "Authorization: Bearer $AGENT_TOKEN" "$@"; echo; }
say() { api -X POST localhost:3000/messages -H 'content-type: application/json' \
          -d "{\"conversationId\":\"demo\",\"message\":\"$1\"}"; }

say "What time is it in Asia/Tokyo?"
say "Create a TypeScript server for this project."   # returns at once: task started
say "Use Fastify instead of Express."                # revises the running task
say "What is the status?"
api localhost:3000/conversations/demo/tasks          # progress, result, workspace path
api localhost:3000/conversations/demo                # the stored turns, with tool calls and results
```

Or chat in a terminal, with replies streaming in as they're written:

```sh
npm run chat              # a new conversation (uses AGENT_TOKEN)
npm run chat -- demo      # join "demo": turns sent with curl above show up here too
```

The stub picks tools by keyword (`time`; `create/build/write/...`; `instead/also/add/change`;
`status/done`; `cancel/stop`), so all of this works without an API key. As
the coding worker it only writes a `NOTES.md` (and runs one command with
`SANDBOX=docker`). For real code set `LLM_PROVIDER=anthropic` and
`ANTHROPIC_API_KEY` in `.env`.

| Env var             | Default                        | Values                                  |
| ------------------- | ------------------------------ | --------------------------------------- |
| `LLM_PROVIDER`      | `stub`                         | `stub` `anthropic`                      |
| `ANTHROPIC_API_KEY` | (required for `anthropic`)     |                                         |
| `ANTHROPIC_MODEL`   | `claude-opus-5-5`              | any Claude model id                     |
| `ANTHROPIC_EFFORT`  | `medium`                       | `low` `medium` `high` `xhigh` `max`     |
| `AUTH`              | `tokens`                       | `tokens` `none`                         |
| `AUTH_TOKENS`       | (required for `tokens`)        | `name:sha256hex`, comma-separated, from `npm run create-token` |
| `PORT`              | `3000`                         | 1-65535                                 |
| `LOG_LEVEL`         | `info`                         | `debug` `info` `warn` `error`           |
| `LOG_FORMAT`        | `pretty` on a TTY, else `json` | `pretty` `json`                         |
| `TASK_WORKER`       | `coding`                       | `coding` `simulated`                    |
| `WORKSPACES_DIR`    | `./workspaces`                 | where task workspaces are created       |
| `SANDBOX`           | `none`                         | `none` (file tools only) `docker` (also `run_command`) |
| `SANDBOX_IMAGE`     | `node:24-slim`                 | image for sandbox containers            |
| `SANDBOX_NETWORK`   | `none`                         | `none` `bridge` (needed for `npm install`) |
| `REPOSITORIES`      | (none)                         | `name=url[#baseBranch]`, comma-separated: the repositories tasks may use |
| `GIT_TOKEN`         | (none)                         | token for private clones and pushes (host-side git only) |
| `ALLOW_GIT_PUSH`    | `false`                        | `true` registers `publish_task`         |
| `ALLOWED_HOSTS`     | (none)                         | host names, besides `localhost` and IP addresses, that requests may be addressed to |
| `ALLOWED_ORIGINS`   | `http://localhost:PORT`, `http://127.0.0.1:PORT` | web origins whose pages may open `/realtime` |

`LOG_LEVEL=debug` also logs the full payload of every LLM request (system
prompt, tool definitions, messages): exactly what the model is told.

## HTTP API

| Route                     | Purpose                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `POST /messages`          | `{ conversationId, message }` → `{ conversationId, turnId, reply }` |
| `GET /conversations/:id`  | stored history, including tool calls and results (debugging)   |
| `GET /conversations/:id/tasks` | the conversation's background tasks and their state       |
| `GET /health`             | liveness check (the only route without a token)                |
| `GET /realtime?conversationId=…` | WebSocket upgrade: the [realtime channel](#the-realtime-channel) |

Every route except `/health` needs `Authorization: Bearer <token>` (see
[Authentication](#authentication)). If the client disconnects mid-turn, the
turn is cancelled (LLM call and tools aborted) and nothing is persisted.

**Every request must be addressed to this server** (`src/http/host-check.ts`):
its `Host` header must be `localhost`, an IP address, or a name in
`ALLOWED_HOSTS` (any port); anything else gets 403. This stops DNS rebinding:
a page you open at `evil.example` switches its DNS record to `127.0.0.1`, and
its requests then reach the agent through your tunnel as same-origin, so CORS
doesn't apply. They still carry `Host: evil.example`. No other site can make
your browser send `Host: localhost` or an IP address, so those are always
allowed.

## Authentication

```
request ─► Host allowed? ─► bearer token ─► Authenticator ─► Principal { id: "alice" }
               403               401                             │
                                       conversationId "demo" ─► "alice/demo" everywhere inside
```

- **Tokens.** `npm run create-token -- <name>` prints a random token
  (`ap_` + 32 random bytes) and the entry `name:sha256(token)` for
  `AUTH_TOKENS`. The server stores only hashes, so its `.env`, a config dump
  or a log can't be replayed to get in. (SHA-256 rather than bcrypt: slow
  hashes protect guessable passwords; a 256-bit random token can't be
  guessed.) Create tokens on your own machine; the token itself never needs
  to exist on the server.
- **Several tokens per user** (one per device, or old and new while rotating):
  list each. Revoking one means removing its entry and restarting.
- **Who you are decides what you see.** Each user's conversation ids live in
  their own namespace: alice's `demo` is stored as `alice/demo`, bob's as
  `bob/demo`. History, tasks, events and turn locks are all keyed by that id,
  so isolation holds by construction; there is no ownership check that a new
  route could forget. Bob gets 404 for alice's conversation, and a fresh
  conversation of his own if he writes to the same id. Clients keep seeing
  their own ids.
- **Both transports**, the same way: REST and the WebSocket handshake read
  the `Authorization` header (Node's WebSocket client can send it; the chat
  client uses `AGENT_TOKEN`). Missing or unknown tokens get 401 before any
  routing, so routes can't be probed. A browser UI can't set headers on a
  WebSocket; it will need a sign-in that sets a cookie, or a short-lived
  ticket.
- **Pluggable.** Transports only call `Authenticator.authenticate(token)`. An
  OIDC/JWT authenticator for real sign-in would be another implementation.
- **`AUTH=none`** makes everyone the user `local`, and logs `auth.disabled` at
  startup. Only for a machine nobody else can reach.

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
2. **permitted**: the run's `ToolPolicy` (`src/tools/tool-policy.ts`). Turns the
   user starts may use every tool; turns the platform starts (task notices)
   only those marked `readOnly`
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
- **The worker is pluggable** (`TaskWorker`): `CodingWorker` (below) by
  default, or `SimulatedCodingWorker` (`TASK_WORKER=simulated`), which only
  reports fake progress.
- **Pull and push.** The agent can check on a task (`get_task`,
  `list_tasks`), and when a task completes or fails the platform tells the
  conversation itself (see [the realtime channel](#the-realtime-channel)).

## The coding worker and its sandbox

`CodingWorker` (`src/tasks/coding-worker.ts`) is a second agent. It runs the
**same loop** as the conversation agent (`runAgentLoop`), with its own system
prompt and a much narrower toolset:

```
conversation agent ─ start_coding_task ─► TaskManager ─► CodingWorker (agent loop)
                                                           ├─ list/read/write/delete_file ─► Workspace
                                                           └─ run_command ─────────────────► DockerCommandSandbox
```

Every call still goes through a `ToolExecutor`; what changes is what exists
behind it. Each task gets one workspace (`<WORKSPACES_DIR>/<taskId>`), kept
across attempts so a revision builds on earlier work.

| Boundary    | How it's enforced                                                                 |
| ----------- | --------------------------------------------------------------------------------- |
| Filesystem  | `Workspace`: relative paths only, no `..`, no symlinks anywhere on a path (commands could plant them), `O_NOFOLLOW`, 256 KB files, listing capped |
| Execution   | each `run_command` is a fresh container: `--read-only` image, `--tmpfs /tmp`, `--cap-drop ALL`, `no-new-privileges`, non-root `--user`, memory/CPU/PID limits |
| Network     | `--network none` by default (`SANDBOX_NETWORK=bridge` to allow `npm install`)    |
| Secrets     | the container gets no host environment: the API key never enters it              |
| Host shell  | none: `docker` is spawned with an argument array; the command string only reaches `sh -c` inside the container |
| Time        | 120 s per command (container removed with `docker rm -f`), 40 LLM steps per attempt, cancel/revise abort everything |

The isolation is tested against a real Docker daemon
(`test/docker-command-sandbox.test.ts`): no network, no secrets in `env`,
zero effective capabilities, read-only system, timeout and cancel remove the
container.

Enable command execution:

```sh
docker pull node:24-slim
SANDBOX=docker npm run dev                     # agent on the host
# or, agent in a container (mounts the Docker socket; read the header first):
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up --build
```

Without `SANDBOX=docker` the worker still runs, but can only edit files.
Run the agent as a non-root user: sandbox containers use its uid.

## Working on a repository

With `REPOSITORIES` set, `start_coding_task` takes an optional `repository`.
Its schema enum *is* the allowlist, so the model can only name a configured
repository, never supply a URL. "Create a /health endpoint for this project"
then runs like this:

```
start_coding_task(repository) ─► TaskCheckout.prepare: clone, branch agent/<taskId>
                              ─► worker loop: read/write files, run_command in the sandbox
                              ─► platform commits the attempt ("Agent Platform" author)
publish_task (when asked)     ─► push agent/<taskId> (never the base branch, never forced)
```

- **The `.git` directory lives outside the sandbox.** The work tree is
  `<WORKSPACES_DIR>/<taskId>` and is mounted into sandbox containers. The git
  directory is `<WORKSPACES_DIR>/.git-dirs/<taskId>.git` and is only used by
  the host. If `.git` were inside the work tree, sandboxed code could write
  `.git/config` (`core.fsmonitor`, filters) or a hook, and the host's next
  `git status` or `git commit` would run it *outside* the sandbox.
  `test/task-checkout.test.ts` plants exactly that and checks nothing runs.
- **Host-side git is pinned down** (`src/repositories/git.ts`):
  - argument arrays, never a shell
  - no system or global config, and no credential helpers from the host
  - hooks and fsmonitor are off
  - `GIT_TOKEN` is passed only as per-command config in the environment:
    never in URLs, argv, files or logs
- **The worker never runs git.** It's told it is on branch `agent/<taskId>`;
  the platform commits after each successful attempt, excluding
  `node_modules`. Revisions add commits on the same branch.
- **Publishing is opt-in** (`ALLOW_GIT_PUSH=true`). It's limited to a
  completed task of the calling conversation, and the result links to
  GitHub's compare page, so you open the pull request yourself.

## The realtime channel

`GET /realtime?conversationId=…` upgrades to a WebSocket on the same port as
the REST API (`src/http/realtime.ts`). A client sends messages and receives
everything that happens in its conversation, as it happens. In `npm run chat`
with `LLM_PROVIDER=anthropic` (the stub's replies are more literal):

```
you> What time is it in Asia/Tokyo?
  [tool] get_current_time {"timeZone":"Asia/Tokyo"}
agent> It is 9:12 PM in Tokyo.                      ← streamed word by word
you> Create a hello world script
  [tool] start_coding_task {"instruction":"Create a hello world script"}
agent> Started task_d6eb14158c; I'll let you know when it's done.
  [task_d6eb14158c] started
  [task_d6eb14158c] progress: Wrote hello.js
  [task_d6eb14158c] completed
[platform] Task task_d6eb14158c has completed.     ← nobody asked: the platform starts this turn
agent> Your hello world script is ready: hello.js prints "Hello, world!".
```

| Direction        | Message                                          | Meaning |
| ---------------- | ------------------------------------------------ | ------- |
| client → server  | `{"type":"message","text":"…"}`                  | start a turn |
|                  | `{"type":"cancel_turn"}`                         | cancel this socket's turns (running and queued) |
| server → client  | `{"type":"ready","conversationId":"…"}`          | subscribed |
|                  | `turn.started` (`initiator`: `user` or `platform`, `text`) | a turn began |
|                  | `reply.delta` (`text`)                           | the next piece of the reply |
|                  | `tool.called` (`name`, `input`) / `tool.finished` (`isError`) | tool activity in the turn |
|                  | `turn.completed` (`reply`) / `turn.failed` (`reason`: `cancelled` or `error`) | the turn ended; `reply` is authoritative |
|                  | `task.updated` (`change`, `task`)                | `started` `progress` `revised` `completed` `failed` `cancelled` `interrupted` |
|                  | `{"type":"error","message":"…"}`                 | a client message was rejected |

How it fits together:

```
AgentRuntime ─┐                         ┌─► WebSocket clients of that conversation
TaskManager ──┼─► ConversationEvents ───┤
              │   (in-process bus)      └─► TaskNotifier ─► runtime.notify() on completed/failed
REST, sockets, notices: every turn publishes the same events
```

- **Publishers don't know who listens.** The runtime and `TaskManager`
  publish to `ConversationEvents` (`src/events/`); transports subscribe. A
  turn sent with curl streams to a socket watching the same conversation, and
  voice will be one more subscriber. Turn events are published under the turn
  lock and task events under the task lock, so they arrive in order and two
  turns never interleave.
- **Streaming crosses the provider boundary as an observer.**
  `LLMRequest.onTextDelta` receives reply text as it is generated; the
  returned response stays authoritative. The Anthropic provider always
  streams (`client.beta.messages.stream`). Partial tool-call arguments aren't
  streamed: a call is reported (`tool.called`) once it is complete, which is
  also when it runs. The loop's `AgentLoopObserver` reports tool calls and
  results; it can't change anything.
- **The platform can start a turn.** When a task completes or fails,
  `TaskNotifier` calls `runtime.notify()`. That turn starts with a `notice`
  message (sent to Claude as user input wrapped in `<platform_notice>`), and
  runs under the `READ_ONLY` tool policy: nobody asked for it, so the model may
  look things up but not start, revise, cancel or publish anything. This
  matters beyond etiquette: a notice carries the task's result, text written
  by the worker model, which repository content may have steered. Whatever it
  says, the turn can't act on it, and it can't close its `<platform_notice>`
  tag early to pose as the user. It also means a notice can't cause another
  notice. The model is still offered every
  tool, so the request prefix and its prompt cache stay the same; a refused
  call becomes an error result (`tool.rejected`, `reason=not_permitted`).
  Notices queue behind the user's turn, like any other turn.
- **Who may connect.** Browsers don't apply CORS to WebSockets: without a
  check, any web page open in your browser could connect to `localhost:3000`
  and drive the agent. The handshake must pass the same `Host` check as REST,
  and its `Origin` must be in `ALLOWED_ORIGINS`. Clients that aren't browsers
  (curl, `npm run chat`) send no `Origin` and are allowed. These checks keep
  other websites out; then, as for REST, the handshake needs a valid bearer
  token, and the socket can only reach its own user's conversation.
- **Limits.** 64 KiB per frame (bigger closes the socket with 1009), the same
  text limit as REST, 3 turns in flight per socket, 1 MiB of unsent output
  before a slow client is dropped, and a 30 s ping that drops dead
  connections. Closing a socket cancels its turns.

## Layout and dependency direction

```
src/
  main.ts                    composition root: the only place concrete classes are chosen
  config.ts                  env vars -> typed config, fail fast
  logger.ts                  structured logger (event name + fields)
  auth/
    tokens.ts                token generation and hashing
    authenticator.ts         Authenticator, Principal, per-user conversation scoping
  http/
    server.ts                HTTP transport adapter (node:http)
    realtime.ts              WebSocket transport (/realtime): events out, messages in
    input-rules.ts           client input limits shared by both transports
    host-check.ts            DNS-rebinding defence: the Host header must name this server
  events/
    conversation-events.ts   the in-process event bus and its event types
  runtime/
    agent-loop.ts            the agent loop, shared by every agent
    agent-runtime.ts         the conversation agent (history, turn lock, persistence)
    system-prompt.ts         static on purpose (prompt caching, thinking replay)
  tasks/
    task.ts                  Task type and allowed status transitions
    task-manager.ts          lifecycle: start, revise, cancel, attempts, ownership
    task-worker.ts           TaskWorker contract
    coding-worker.ts         the worker agent: agent loop + workspace tools + sandbox
    simulated-coding-worker.ts  stand-in worker (no code is written)
    task-store.ts            async store interface + in-memory impl
    task-tools.ts            the five tools the agent uses to drive tasks
    task-notifier.ts         announces finished tasks through platform-started turns
  tools/
    tool.ts                  Tool contract + ToolError
    tool-registry.ts         which tools exist; schema compilation
    tool-executor.ts         the trust boundary
    tool-policy.ts           which tools a run may use (READ_ONLY for platform turns)
    get-current-time.ts      first native tool
  llm/
    llm-provider.ts          the provider boundary
    anthropic-provider.ts    Claude via the Anthropic SDK (the only file that knows its format)
    stub-llm-provider.ts     deterministic fake that speaks tool calls
  conversation/              async, append-only store interface + in-memory impl
  sandbox/
    workspace.ts             the filesystem boundary
    workspace-tools.ts       list/read/write/delete_file
    command-sandbox.ts       CommandSandbox contract + run_command tool
    docker-command-sandbox.ts  one locked-down container per command
  repositories/
    git.ts                   hardened host-side git runner
    repository-catalog.ts    the REPOSITORIES allowlist
    task-checkout.ts         clone / commit / push, git dir outside the sandbox
    publish-task-tool.ts     publish_task
  core/                      provider-neutral messages, tool definitions, KeyedMutex
scripts/
  chat.ts                    terminal client for the realtime channel (no dependencies)
  create-token.ts            prints a new API token and its AUTH_TOKENS entry
```

```
http, realtime ──► runtime ──► LLMProvider (interface)      ◄── anthropic, stub
                        ├────► ToolExecutor ──► ToolRegistry ◄── native tools, task tools (later: MCP tools)
                        │                                          └─► TaskManager ──► TaskWorker, TaskStore
                        │                                                               └─ CodingWorker ─► runAgentLoop, Workspace, CommandSandbox, TaskCheckout
                        └────► ConversationStore (interface) ◄── in-memory
runtime, TaskManager ──► ConversationEvents ◄── realtime, TaskNotifier (subscribers)
everything ──► core/
```

## Log events

Lines inside a turn carry `conversationId`, `turnId` and, inside the loop, `step`.
Tool lines add `toolCallId` and `tool`; task lines carry `conversationId`,
`taskId` and `attempt`.

| Event                 | Meaning                                                    |
| --------------------- | ---------------------------------------------------------- |
| `user.message`        | turn started by the user                                   |
| `platform.notice`     | turn started by the platform (a task finished)             |
| `llm.request`         | runtime calls the provider (message count, offered tools)  |
| `llm.request.payload` | debug only: the full request                               |
| `llm.response`        | text, tool calls, stop reason, token usage, model, latency |
| `tool.request`        | the model asked for a tool (untrusted input)               |
| `tool.rejected`       | refused at the trust boundary (`reason`: unknown tool, not permitted, invalid input) |
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
| `worker.started`      | a coding worker attempt began (workspace path); its own `llm.*`/`tool.*` lines carry `taskId`, `attempt`, `agent=coding-worker` |
| `sandbox.runs_as_root`| warning: sandboxed commands would run as uid 0              |
| `git.cloned` / `git.committed` / `git.pushed` | repository checkout, per-attempt commit, publish (repository, branch, commit) |
| `git.clone_failed` / `git.push_failed` | clone or push failed (details in the log, a short reason to the model) |
| `http.rejected`       | 4xx: refused at the transport (bad input, `Host` not allowed, 401 without a valid token); carries `principal` once known |
| `auth.disabled`       | warning at startup: `AUTH=none`                            |
| `realtime.connected` / `realtime.disconnected` | a WebSocket opened / closed (`connectionId`; turns cancelled by the close) |
| `realtime.rejected`   | handshake refused (`Host` or `Origin` not allowed, wrong path, 401, bad conversationId) |
| `realtime.invalid_message` | a client message was rejected (sent back as `error`)  |
| `realtime.cancel_turn` | the client cancelled its turns                            |
| `realtime.slow_client` | dropped: too much unsent output                           |
| `events.listener_failed` | a subscriber threw; the publisher carried on            |
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
- The event bus is in-process: a second instance wouldn't see the first's
  events. Several instances need a shared bus or per-conversation routing.
- A finished task costs one LLM call for its notice, whether or not anyone is
  connected; the reply waits in the history.
- Workspaces and checkouts are never cleaned up. Each task clones the whole
  base branch; submodules and Git LFS aren't supported.
- Tokens don't expire, and revoking one needs a restart. Every user has the
  same tools and repositories: there are no per-user permissions yet.
- The API speaks plain HTTP, so a token is only as private as the network it
  crosses. Keep the port private (the SSM tunnel in DEPLOY.md) until there is
  HTTPS in front.
- An in-process tool that ignores its abort signal keeps running after a
  timeout; the runtime just stops waiting. (Sandboxed commands don't have
  this problem: their container is removed.)
