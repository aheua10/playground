# agent-platform

A learning project: an agent runtime built without an agent framework, so the
agent loop, the tool trust boundary, and the provider abstraction are all
visible in our own code.

**Status: Phase 4 complete.**
- **Phase 1:** conversations over HTTP, an explicit agent loop, a native tool
  (`get_current_time`) behind a trust boundary, and two LLM providers: a
  deterministic stub (default, no API key) and Anthropic (Claude).
- **Phase 2:** background tasks the conversation can start, inspect, revise and
  cancel while it carries on.
- **Phase 3:** the coding worker, a second agent that writes code in a
  per-task workspace and runs commands in locked-down Docker containers.

- **Phase 4:** tasks can work on an existing repository: a checkout on a
  task branch, committed for the worker, and pushed on request.

Not yet: MCP, persistence, authentication, realtime/voice. Deploying: see
[DEPLOY.md](DEPLOY.md).

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
curl -s localhost:3000/conversations/demo/tasks      # progress, result, workspace path
curl -s localhost:3000/conversations/demo            # the stored turns, with tool calls and results
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
- **The worker is pluggable** (`TaskWorker`): `CodingWorker` (below) by
  default, or `SimulatedCodingWorker` (`TASK_WORKER=simulated`), which only
  reports fake progress.
- **Pull, not push (for now).** The agent learns about progress when it calls
  `get_task`/`list_tasks`, e.g. because the user asks. Telling the user
  unprompted ("your server is ready") needs a realtime channel, which comes
  with WebSockets/voice.

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

## Layout and dependency direction

```
src/
  main.ts                    composition root: the only place concrete classes are chosen
  config.ts                  env vars -> typed config, fail fast
  logger.ts                  structured logger (event name + fields)
  http/server.ts             HTTP transport adapter (node:http)
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
```

```
http ──► runtime ──► LLMProvider (interface)      ◄── anthropic, stub
              ├────► ToolExecutor ──► ToolRegistry ◄── native tools, task tools (later: MCP tools)
              │                                          └─► TaskManager ──► TaskWorker, TaskStore
              │                                                               └─ CodingWorker ─► runAgentLoop, Workspace, CommandSandbox, TaskCheckout
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
| `worker.started`      | a coding worker attempt began (workspace path); its own `llm.*`/`tool.*` lines carry `taskId`, `attempt`, `agent=coding-worker` |
| `sandbox.runs_as_root`| warning: sandboxed commands would run as uid 0              |
| `git.cloned` / `git.committed` / `git.pushed` | repository checkout, per-attempt commit, publish (repository, branch, commit) |
| `git.clone_failed` / `git.push_failed` | clone or push failed (details in the log, a short reason to the model) |
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
- Workspaces and checkouts are never cleaned up. Each task clones the whole
  base branch; submodules and Git LFS aren't supported.
- The HTTP API has no authentication: keep it private (see DEPLOY.md).
- Responses are not streamed (needed later for voice).
- An in-process tool that ignores its abort signal keeps running after a
  timeout; the runtime just stops waiting. (Sandboxed commands don't have
  this problem: their container is removed.)
