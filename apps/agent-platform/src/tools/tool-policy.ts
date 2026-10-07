import type { Tool } from "./tool.ts";

// Which tools a run may use: the "permitted" gate of the ToolExecutor.
//
// The model is still OFFERED every tool; the policy is enforced when a call
// arrives. Offering the same tools on every turn keeps the request prefix
// identical, so the provider's prompt cache and Anthropic's thinking replay
// keep working across turns with different policies. A call the policy refuses
// becomes an error result the model can read, like any other rejected call.

export interface ToolPolicy {
  /** For the audit log. */
  name: string;
  permits(tool: Tool<never>): boolean;
  /** Told to the model when it calls a tool the policy doesn't permit. */
  refusal: string;
}

/**
 * For turns nobody asked for (platform notices): looking things up is fine,
 * acting is not. It also means a notice can't cause more notices.
 */
export const READ_ONLY: ToolPolicy = {
  name: "read-only",
  permits: (tool) => tool.readOnly === true,
  refusal: "This turn was started by the platform, not the user, so only read-only tools can be used. Tell the user instead, and let them decide.",
};
