import type { ConversationEvents } from "../events/conversation-events.ts";
import type { AgentRuntime } from "../runtime/agent-runtime.ts";

// Tells a conversation when one of its tasks finishes, without waiting for the
// user to ask. A completed or failed task becomes a platform notice, and the
// agent turns it into a message for the user: streamed to realtime clients,
// and kept in the history for everyone else.
//
// Not announced: cancelled tasks (the user just asked for that), and tasks
// interrupted by a shutdown (the server is going away).
//
// A notice turn may only use read-only tools, so it can't change a task, and
// so it can't trigger another notice.

export function startTaskNotifier(deps: {
  events: ConversationEvents;
  runtime: Pick<AgentRuntime, "notify">;
}): () => void {
  return deps.events.subscribeAll((event) => {
    if (event.type !== "task.updated") return;
    if (event.change !== "completed" && event.change !== "failed") return;
    const { task, conversationId } = event;
    const notice = `Task ${task.taskId} has ${event.change}.\n${JSON.stringify(task)}`;
    // Runs in the background, queued behind any turn in progress.
    // notify() logs its own failures.
    deps.runtime.notify({ conversationId, notice }).catch(() => {});
  });
}
