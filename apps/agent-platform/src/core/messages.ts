// Provider-neutral conversation messages.
//
// These are OUR types, not any LLM vendor's wire format. The conversation store
// persists them, the runtime creates them, and each LLM provider adapter
// translates them to/from its own API shape.
//
// Deliberately minimal for the skeleton: text only. When tools arrive, this
// union grows (assistant messages that carry tool calls, plus a tool-result
// message). That change is the subject of the next checkpoint.

export type UserMessage = {
  role: "user";
  content: string;
};

export type AssistantMessage = {
  role: "assistant";
  content: string;
};

export type Message = UserMessage | AssistantMessage;
