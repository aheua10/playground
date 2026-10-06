import { loadConfig } from "./config.ts";
import { InMemoryConversationStore } from "./conversation/in-memory-conversation-store.ts";
import { createHttpServer } from "./http/server.ts";
import { StubLLMProvider } from "./llm/stub-llm-provider.ts";
import { createLogger } from "./logger.ts";
import { AgentRuntime } from "./runtime/agent-runtime.ts";

// Composition root. The only file that knows which concrete implementations
// are in use; everything else depends on interfaces. Swapping the stub LLM for
// a real provider, or the in-memory store for a database, is a change here.

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, format: config.logFormat });

const store = new InMemoryConversationStore();
const llm = new StubLLMProvider();
const runtime = new AgentRuntime({ llm, store, logger });
const server = createHttpServer({ runtime, logger });

server.listen(config.port, () => {
  logger.info("server.started", { port: config.port, llmProvider: llm.name, conversationStore: "in-memory" });
});

// Containers stop us with SIGTERM (docker stop, ECS deploys). Stop accepting
// connections, let in-flight requests finish, then exit. Force-exit if that
// takes too long.
function shutdown(signal: string): void {
  logger.info("server.stopping", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
