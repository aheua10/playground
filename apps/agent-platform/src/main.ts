import { type Authenticator, NoAuthenticator, TokenAuthenticator } from "./auth/authenticator.ts";
import { type AuthConfig, loadConfig, type LLMConfig, type TaskWorkerConfig } from "./config.ts";
import { InMemoryConversationStore } from "./conversation/in-memory-conversation-store.ts";
import { ConversationEvents } from "./events/conversation-events.ts";
import { attachRealtime } from "./http/realtime.ts";
import { createHttpServer } from "./http/server.ts";
import { AnthropicProvider } from "./llm/anthropic-provider.ts";
import type { LLMProvider } from "./llm/llm-provider.ts";
import { StubLLMProvider } from "./llm/stub-llm-provider.ts";
import { createLogger, type Logger } from "./logger.ts";
import { tokenAuth } from "./repositories/git.ts";
import { createPublishTaskTool } from "./repositories/publish-task-tool.ts";
import { RepositoryCatalog } from "./repositories/repository-catalog.ts";
import { AgentRuntime } from "./runtime/agent-runtime.ts";
import type { CommandSandbox } from "./sandbox/command-sandbox.ts";
import { DockerCommandSandbox } from "./sandbox/docker-command-sandbox.ts";
import { CodingWorker } from "./tasks/coding-worker.ts";
import { SimulatedCodingWorker } from "./tasks/simulated-coding-worker.ts";
import { TaskManager } from "./tasks/task-manager.ts";
import { startTaskNotifier } from "./tasks/task-notifier.ts";
import { InMemoryTaskStore } from "./tasks/task-store.ts";
import { createTaskTools } from "./tasks/task-tools.ts";
import type { TaskWorker } from "./tasks/task-worker.ts";
import { createGetCurrentTimeTool } from "./tools/get-current-time.ts";
import { ToolExecutor } from "./tools/tool-executor.ts";
import { ToolRegistry } from "./tools/tool-registry.ts";

// Composition root. The only file that knows which concrete implementations
// are in use; everything else depends on interfaces. Swapping the LLM provider,
// the store, or adding a tool is a change here.

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, format: config.logFormat });

const llm = createLLMProvider(config.llm);
const repositories = new RepositoryCatalog(config.worker.kind === "coding" ? config.worker.repositories : []);
// Like ANTHROPIC_API_KEY, the git token is read from the environment here and
// handed only to the code that uses it; it is not part of the config object.
const gitAuth = tokenAuth(process.env.GIT_TOKEN);
const worker = await createTaskWorker(config.worker, llm, logger);
const events = new ConversationEvents(logger);
const tasks = new TaskManager({ store: new InMemoryTaskStore(), worker, logger, events });

const toolRegistry = new ToolRegistry();
toolRegistry.register(createGetCurrentTimeTool());
for (const tool of createTaskTools(tasks, { repositories: repositories.names() })) toolRegistry.register(tool);
if (config.worker.kind === "coding" && config.worker.allowGitPush) {
  const { workspacesDir } = config.worker;
  toolRegistry.register(createPublishTaskTool({ tasks, repositories, workspacesDir, gitAuth, logger }));
}

const store = new InMemoryConversationStore();
const toolExecutor = new ToolExecutor({ registry: toolRegistry });
const runtime = new AgentRuntime({ llm, store, toolExecutor, logger, events });
startTaskNotifier({ events, runtime });
const authenticator = createAuthenticator(config.auth);
const { allowedHosts, allowedOrigins } = config;
const server = createHttpServer({ runtime, tasks, logger, authenticator, allowedHosts });
const realtime = attachRealtime(server, { runtime, events, logger, authenticator, allowedHosts, allowedOrigins });

server.listen(config.port, () => {
  logger.info("server.started", {
    port: config.port,
    auth: authenticator.kind,
    principals: authenticator instanceof TokenAuthenticator ? authenticator.principals() : undefined,
    allowedHosts: ["localhost", "IP addresses", ...allowedHosts],
    realtime: { path: "/realtime", allowedOrigins },
    llmProvider: llm.name,
    model: config.llm.provider === "anthropic" ? config.llm.model : undefined,
    tools: toolExecutor.definitions().map((tool) => tool.name),
    conversationStore: "in-memory",
    taskWorker: config.worker.kind,
    workspacesDir: config.worker.kind === "coding" ? config.worker.workspacesDir : undefined,
    sandbox: config.worker.kind === "coding" ? config.worker.sandbox.kind : undefined,
    repositories: repositories.names(),
    gitPush: config.worker.kind === "coding" && config.worker.allowGitPush,
  });
});

function createAuthenticator(authConfig: AuthConfig): Authenticator {
  if (authConfig.kind === "tokens") return new TokenAuthenticator(authConfig.tokens);
  logger.warn("auth.disabled", { hint: "AUTH=none: anyone who can reach the port can use the agent" });
  return new NoAuthenticator();
}

function createLLMProvider(llmConfig: LLMConfig): LLMProvider {
  switch (llmConfig.provider) {
    case "stub":
      // A short pause between words, so streaming is visible in the chat client.
      return new StubLLMProvider({ wordDelayMs: 30 });
    case "anthropic":
      return new AnthropicProvider({ model: llmConfig.model, effort: llmConfig.effort });
  }
}

async function createTaskWorker(workerConfig: TaskWorkerConfig, llm: LLMProvider, log: Logger): Promise<TaskWorker> {
  if (workerConfig.kind === "simulated") return new SimulatedCodingWorker();

  let sandbox: CommandSandbox | undefined;
  if (workerConfig.sandbox.kind === "docker") {
    const docker = new DockerCommandSandbox(workerConfig.sandbox);
    await docker.verify(); // fail at startup, not in the middle of a task
    if (process.getuid?.() === 0) {
      log.warn("sandbox.runs_as_root", { hint: "run the agent as a non-root user; sandboxed commands use its uid" });
    }
    sandbox = docker;
  }
  return new CodingWorker({
    llm,
    workspacesDir: workerConfig.workspacesDir,
    sandbox,
    repositories,
    gitAuth,
    logger: log,
  });
}

// Containers stop us with SIGTERM (docker stop, ECS deploys). Stop accepting
// connections, close WebSockets (which cancels their turns), let in-flight
// requests finish, record running tasks as interrupted (they live in memory),
// then exit. Force-exit if that takes too long.
function shutdown(signal: string): void {
  logger.info("server.stopping", { signal });
  realtime.close();
  server.close(() => {
    void tasks.shutdown().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
