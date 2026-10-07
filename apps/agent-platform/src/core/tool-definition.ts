// What a model is told about a tool: a name, a description of when to use it,
// and a JSON Schema for its input.
//
// Provider-neutral: each adapter maps it to its own format (Anthropic
// `input_schema`, OpenAI `parameters`, ...). MCP servers describe their tools
// with the same three fields, which is what will let native and MCP tools share
// one registry later.

export interface ToolDefinition {
  /** Unique, [a-zA-Z0-9_-]{1,64} (the common denominator across providers). */
  name: string;
  /** Tells the model what the tool does and WHEN to call it. */
  description: string;
  /** JSON Schema (2020-12) for the input object. Also used to validate calls. */
  inputSchema: JsonSchemaObject;
}

export type JsonSchemaObject = {
  type: "object";
  [keyword: string]: unknown;
};
