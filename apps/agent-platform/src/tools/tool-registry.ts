import { Ajv2020 } from "ajv/dist/2020.js";
import type { ToolDefinition } from "../core/tool-definition.ts";
import type { Tool } from "./tool.ts";

// The set of tools that exist. If a tool is not registered here, the model
// cannot run it, whatever it asks for.
//
// Later, MCP-discovered tools get registered here too (wrapped as `Tool`s whose
// execute() forwards to the MCP client), so the model sees one tool list and
// every call goes through the same validation path.

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export interface RegisteredTool {
  tool: Tool;
  /** Returns null if `input` matches the tool's schema, otherwise a readable error. */
  validateInput(input: unknown): string | null;
}

export class ToolRegistry {
  readonly #ajv = new Ajv2020({ allErrors: true, strict: true });
  readonly #tools = new Map<string, RegisteredTool>();

  register(tool: Tool<never>): void {
    const { name, inputSchema } = tool.definition;
    if (!TOOL_NAME_PATTERN.test(name)) throw new Error(`Invalid tool name "${name}"`);
    if (this.#tools.has(name)) throw new Error(`Tool "${name}" is already registered`);

    // Compile now so a broken schema fails at startup, not mid-conversation.
    const validate = this.#ajv.compile(inputSchema);
    this.#tools.set(name, {
      tool: tool as Tool,
      validateInput: (input) =>
        validate(input) ? null : this.#ajv.errorsText(validate.errors, { dataVar: "input" }),
    });
  }

  get(name: string): RegisteredTool | undefined {
    return this.#tools.get(name);
  }

  /** Sorted by name: a stable tool list keeps provider prompt caches valid. */
  definitions(): ToolDefinition[] {
    return [...this.#tools.values()]
      .map(({ tool }) => tool.definition)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
