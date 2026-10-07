import { loadConfig, type LLMConfig } from "./config.ts";
import { InMemoryConversationStore } from "./conversation/in-memory-conversation-store.ts";
import { createHttpServer } from "./http/server.ts";
import { AnthropicProvider } from "./llm/anthropic-provider.ts";
import type { LLMProvider } from "./llm/llm-provider.ts";
import { StubLLMProvider } from "./llm/stub-llm-provider.ts";
import { createLogger } from "./logger.ts";
import { AgentRuntime } from "./runtime/agent-runtime.ts";
import { createGetCurrentTimeTool } from "./tools/get-current-time.ts";
import { ToolExecutor } from "./tools/tool-executor.ts";
import { ToolRegistry } from "./tools/tool-registry.ts";

// Composition root. The only file that knows which concrete implementations
// are in use; everything else depends on interfaces. Swapping the LLM provider,
// the store, or adding a tool is a change here.

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, format: config.logFormat });

const toolRegistry = new ToolRegistry();
toolRegistry.register(createGetCurrentTimeTool());

const store = new InMemoryConversationStore();
const llm = createLLMProvider(config.llm);
const toolExecutor = new ToolExecutor({ registry: toolRegistry });
const runtime = new AgentRuntime({ llm, store, toolExecutor, logger });
const server = createHttpServer({ runtime, logger });

server.listen(config.port, () => {
  logger.info("server.started", {
    port: config.port,
    llmProvider: llm.name,
    model: config.llm.provider === "anthropic" ? config.llm.model : undefined,
    tools: toolExecutor.definitions().map((tool) => tool.name),
    conversationStore: "in-memory",
  });
});

function createLLMProvider(llmConfig: LLMConfig): LLMProvider {
  switch (llmConfig.provider) {
    case "stub":
      return new StubLLMProvider();
    case "anthropic":
      return new AnthropicProvider({ model: llmConfig.model, effort: llmConfig.effort });
  }
}

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
