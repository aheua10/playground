import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MAX_FILE_BYTES, Workspace } from "../src/sandbox/workspace.ts";
import { createWorkspaceTools } from "../src/sandbox/workspace-tools.ts";
import { ToolError } from "../src/tools/tool.ts";
import { ToolExecutor } from "../src/tools/tool-executor.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { captureLogger } from "./helpers.ts";

// Each test gets a base dir holding the workspace and, next to it, an
// "outside" dir with a secret the workspace must never reach.
async function setup() {
  const base = await mkdtemp(path.join(tmpdir(), "workspace-test-"));
  const outside = path.join(base, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "top secret");
  const workspace = await Workspace.open(path.join(base, "workspaces"), "task_test");
  return { workspace, outside };
}

test("writes, reads and lists files, creating parent directories", async () => {
  const { workspace } = await setup();

  await workspace.writeFile("src/server.ts", "console.log('hi');");
  await workspace.writeFile("package.json", "{}");
  await mkdir(path.join(workspace.root, "node_modules", "fastify"), { recursive: true });

  assert.equal(await workspace.readFile("src/server.ts"), "console.log('hi');");
  assert.deepEqual(await workspace.listFiles(), {
    files: [
      { path: "node_modules/", bytes: 0 },
      { path: "package.json", bytes: 2 },
      { path: "src/server.ts", bytes: 18 },
    ],
    truncated: false,
  });
});

test("refuses paths that leave the workspace", async () => {
  const { workspace } = await setup();
  for (const bad of ["", "/etc/passwd", "../outside/secret.txt", "src/../../outside/secret.txt", ".", "a/../.."]) {
    await assert.rejects(workspace.readFile(bad), ToolError, `read ${JSON.stringify(bad)}`);
    await assert.rejects(workspace.writeFile(bad, "x"), ToolError, `write ${JSON.stringify(bad)}`);
  }
});

test("refuses to follow a symlinked directory out of the workspace", async () => {
  const { workspace, outside } = await setup();
  // What a sandboxed command could do: ln -s /some/outside/dir link
  await symlink(outside, path.join(workspace.root, "link"));

  await assert.rejects(workspace.readFile("link/secret.txt"), /symlink/);
  await assert.rejects(workspace.writeFile("link/planted.txt", "x"), /symlink/);
  await assert.rejects(stat(path.join(outside, "planted.txt")), { code: "ENOENT" });
});

test("refuses to read or write through a symlinked file", async () => {
  const { workspace, outside } = await setup();
  await symlink(path.join(outside, "secret.txt"), path.join(workspace.root, "evil.txt"));

  await assert.rejects(workspace.readFile("evil.txt"), /symlink/);
  await assert.rejects(workspace.writeFile("evil.txt", "overwritten"), /symlink/);
  assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "top secret");
  // Listing skips symlinks rather than following them.
  assert.deepEqual((await workspace.listFiles()).files, []);
  // Deleting removes the link itself, never its target.
  await workspace.deleteFile("evil.txt");
  assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "top secret");
});

test("enforces size limits and rejects unsafe workspace names", async () => {
  const { workspace } = await setup();
  await assert.rejects(workspace.writeFile("big.txt", "x".repeat(MAX_FILE_BYTES + 1)), /larger than/);
  await assert.rejects(workspace.readFile("missing.txt"), /does not exist/);
  await assert.rejects(Workspace.open(tmpdir(), "../escape"), /Invalid workspace name/);
});

test("workspace tools: input validated, errors fed back, progress reported", async () => {
  const { workspace } = await setup();
  const notes: string[] = [];
  const registry = new ToolRegistry();
  for (const tool of createWorkspaceTools(workspace, (note) => notes.push(note))) registry.register(tool);
  const executor = new ToolExecutor({ registry });
  const { logger } = captureLogger();
  const run = (name: string, input: unknown) =>
    executor.execute(
      { id: "call", name, input },
      { conversationId: "c", turnId: "t", signal: new AbortController().signal, log: logger },
    );

  assert.equal((await run("write_file", { path: "a/b.txt", content: "hello" })).isError, false);
  assert.equal((await run("read_file", { path: "a/b.txt" })).content, "hello");
  const escape = await run("read_file", { path: "../../etc/passwd" });
  assert.ok(escape.isError);
  assert.match(escape.content, /outside the workspace/);
  assert.deepEqual(notes, ["Wrote a/b.txt (5 bytes)"]);
});
