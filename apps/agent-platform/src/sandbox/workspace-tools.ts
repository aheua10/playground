import type { Tool } from "../tools/tool.ts";
import type { Workspace } from "./workspace.ts";

// File tools for the coding worker. They are created per task attempt with
// the workspace bound in, so the model never names a workspace: it can only
// use paths relative to the one it was given. All checks live in Workspace.

const PATH = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  description: 'Path relative to the workspace root, e.g. "src/server.ts".',
};

export function createWorkspaceTools(workspace: Workspace, reportProgress: (note: string) => void): Tool<never>[] {
  const listFiles: Tool<Record<string, never>> = {
    readOnly: true,
    definition: {
      name: "list_files",
      description:
        "Lists every file in the workspace with its size. node_modules and .git are shown as a single " +
        "entry. Use it first to see what a previous attempt left behind.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    execute: () => workspace.listFiles(),
  };

  const readFile: Tool<{ path: string }> = {
    readOnly: true,
    definition: {
      name: "read_file",
      description: "Returns the content of a text file in the workspace.",
      inputSchema: { type: "object", properties: { path: PATH }, required: ["path"], additionalProperties: false },
    },
    execute: ({ path }) => workspace.readFile(path),
  };

  const writeFile: Tool<{ path: string; content: string }> = {
    definition: {
      name: "write_file",
      description:
        "Creates or overwrites a file in the workspace with the given content, creating parent " +
        "directories as needed. Always write the complete file.",
      inputSchema: {
        type: "object",
        properties: { path: PATH, content: { type: "string", description: "The full file content." } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    execute: async ({ path, content }) => {
      const bytes = await workspace.writeFile(path, content);
      reportProgress(`Wrote ${path} (${bytes} bytes)`);
      return { path, bytes };
    },
  };

  const deleteFile: Tool<{ path: string }> = {
    definition: {
      name: "delete_file",
      description: "Deletes a file from the workspace (not directories).",
      inputSchema: { type: "object", properties: { path: PATH }, required: ["path"], additionalProperties: false },
    },
    execute: async ({ path }) => {
      await workspace.deleteFile(path);
      reportProgress(`Deleted ${path}`);
      return { deleted: path };
    },
  };

  return [listFiles, readFile, writeFile, deleteFile];
}
