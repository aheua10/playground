import { ToolError, type Tool } from "./tool.ts";

// The first native tool: deliberately trivial so the tool *mechanics* are the
// interesting part. Two layers of validation are visible here:
//   - structural: the runtime checks the input against inputSchema (types, no
//     extra fields) before execute() is ever called
//   - semantic: only the tool knows whether a string is a real time zone

type GetCurrentTimeInput = { timeZone?: string };

/** `now` is injectable so tests are deterministic. */
export function createGetCurrentTimeTool(now: () => Date = () => new Date()): Tool<GetCurrentTimeInput> {
  return {
    readOnly: true,
    definition: {
      name: "get_current_time",
      description:
        "Returns the current date and time. Call this whenever the user asks for the current time, " +
        "date or day of the week, or when an answer depends on it. Never guess the time.",
      inputSchema: {
        type: "object",
        properties: {
          timeZone: {
            type: "string",
            description: 'IANA time zone name, e.g. "Europe/Berlin" or "America/New_York". Defaults to "UTC".',
          },
        },
        additionalProperties: false,
      },
    },

    async execute({ timeZone = "UTC" }) {
      let formatter: Intl.DateTimeFormat;
      try {
        formatter = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "full", timeStyle: "long" });
      } catch {
        throw new ToolError(`Unknown time zone "${timeZone}". Use an IANA name such as "Europe/Berlin".`);
      }
      const date = now();
      return { timeZone, iso: date.toISOString(), local: formatter.format(date) };
    },
  };
}
