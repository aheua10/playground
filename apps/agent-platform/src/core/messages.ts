// Provider-neutral conversation messages.
//
// These are OUR types, not any LLM vendor's wire format. The conversation store
// persists them, the runtime creates them, and each LLM provider adapter
// translates them to and from its own API shape.

export type UserMessage = {
  role: "user";
  content: string;
};

/**
 * A message from the platform rather than the user, e.g. "task X completed".
 * It starts a turn nobody asked for; providers present it to the model as
 * clearly marked platform input, not as something the user said.
 */
export type NoticeMessage = {
  role: "notice";
  content: string;
};

/** A request from the model to run one of our tools. The model proposes; the runtime decides. */
export type ToolCall = {
  /** Provider-assigned id. The matching ToolResultMessage must echo it. */
  id: string;
  name: string;
  /** Model-generated arguments. `unknown` on purpose: nothing may use them before validation. */
  input: unknown;
};

export type AssistantMessage = {
  role: "assistant";
  /** Visible reply text. May be empty when the model only requests tools. */
  content: string;
  toolCalls: ToolCall[];
  /** The provider's own copy of this message, replayed verbatim to that provider. See below. */
  raw?: ProviderRawMessage;
};

/** The outcome of running one ToolCall, fed back to the model on the next LLM call. */
export type ToolResultMessage = {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
};

export type Message = UserMessage | NoticeMessage | AssistantMessage | ToolResultMessage;

// Why `raw` exists: provider neutrality has a limit. Some providers return
// opaque state that must be sent back unchanged on later requests. Anthropic's
// thinking blocks, for example, are signed and bound to the conversation;
// rebuilding the assistant turn from `content` + `toolCalls` would drop them
// and the next request would be rejected. So the adapter that produced a
// message stores its exact wire form here and replays it. Our own code only
// reads `content` and `toolCalls`; `data` is opaque outside that adapter.
export type ProviderRawMessage = {
  provider: string;
  data: unknown;
};
