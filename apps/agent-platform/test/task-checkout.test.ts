import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { git } from "../src/repositories/git.ts";
import { TaskCheckout } from "../src/repositories/task-checkout.ts";
import { Workspace } from "../src/sandbox/workspace.ts";
import { AUTHOR, createRemote } from "./helpers.ts";

async function setup() {
  const { repository, remoteDir } = await createRemote();
  const workspacesDir = await mkdtemp(path.join(tmpdir(), "checkout-workspaces-"));
  const workspace = await Workspace.open(workspacesDir, "task_abc");
  const prepare = () => TaskCheckout.prepare({ repository, workspace, workspacesDir, taskId: "task_abc" });
  return { repository, remoteDir, workspacesDir, workspace, prepare };
}

test("clones into the workspace with the git dir kept outside it", async () => {
  const { workspace, workspacesDir, prepare } = await setup();

  const { checkout, cloned } = await prepare();

  assert.equal(cloned, true);
  assert.equal(checkout.branch, "agent/task_abc");
  assert.equal(await checkout.baseBranch(), "main");
  // The work tree has the project files and nothing git-related...
  assert.deepEqual((await readdir(workspace.root)).sort(), ["README.md", "package.json"]);
  // ...the git dir is a sibling the sandbox never mounts.
  await access(path.join(workspacesDir, ".git-dirs", "task_abc.git", "HEAD"));
  // A second attempt reuses the checkout.
  assert.equal((await prepare()).cloned, false);
});

test("commits the worker's changes on the task branch, excluding node_modules", async () => {
  const { workspace, prepare } = await setup();
  const { checkout } = await prepare();

  assert.equal(await checkout.commitAll("nothing yet"), undefined);

  await workspace.writeFile("src/server.ts", "export {};\n");
  await workspace.writeFile("node_modules/fastify/index.js", "// installed by npm in the sandbox\n");
  const commit = await checkout.commitAll("Add server");

  assert.match(commit ?? "", /^[0-9a-f]{7,}$/);
  const summary = await checkout.changeSummary();
  assert.match(summary, /src\/server\.ts/);
  assert.doesNotMatch(summary, /node_modules/);
});

test("sandboxed code can't make the host run commands through git", async () => {
  const { workspace, prepare } = await setup();
  const { checkout } = await prepare();
  const marker = path.join(workspace.root, "..", "PWNED");

  // Everything a malicious command in the sandbox could plant in the work tree:
  // a .git dir with config that runs commands, hooks, and a filter attribute.
  await mkdir(path.join(workspace.root, ".git", "hooks"), { recursive: true });
  await writeFile(
    path.join(workspace.root, ".git", "config"),
    `[core]\n\tfsmonitor = "touch ${marker}"\n\thooksPath = .git/hooks\n[filter "evil"]\n\tclean = "touch ${marker}"\n`,
  );
  for (const hook of ["pre-commit", "post-commit"]) {
    await writeFile(path.join(workspace.root, ".git", "hooks", hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  }
  await writeFile(path.join(workspace.root, ".gitattributes"), "* filter=evil\n");
  await writeFile(path.join(workspace.root, "app.js"), "console.log('hi');\n");

  await checkout.commitAll("Add app");
  await checkout.changeSummary();

  await assert.rejects(access(marker), { code: "ENOENT" });
  assert.doesNotMatch(await checkout.changeSummary(), /\.git\//);
});

test("pushes the task branch without ever forcing", async () => {
  const { workspace, remoteDir, prepare } = await setup();
  const { checkout } = await prepare();
  await workspace.writeFile("feature.txt", "v1\n");
  await checkout.commitAll("Add feature");

  await checkout.push();

  const remoteBranches = await git(["branch", "--list"], { gitDir: remoteDir });
  assert.match(remoteBranches, /agent\/task_abc/);
  // The base branch is untouched: still exactly one commit.
  assert.equal((await git(["rev-list", "--count", "main"], { gitDir: remoteDir })).trim(), "1");

  // Someone else pushes to the same branch; our next push must fail, not overwrite theirs.
  const elsewhere = await mkdtemp(path.join(tmpdir(), "elsewhere-"));
  await git(["clone", "--quiet", "--branch", "agent/task_abc", `file://${remoteDir}`, elsewhere]);
  await writeFile(path.join(elsewhere, "theirs.txt"), "theirs\n");
  await git(["add", "--all"], { cwd: elsewhere });
  await git(["commit", "--quiet", "-m", "Their change"], { cwd: elsewhere, config: AUTHOR });
  await git(["push", "--quiet", "origin", "agent/task_abc"], { cwd: elsewhere });

  await workspace.writeFile("feature.txt", "v2\n");
  await checkout.commitAll("Change feature");
  await assert.rejects(checkout.push(), /push failed/);
  assert.match(await git(["log", "--format=%s", "agent/task_abc"], { gitDir: remoteDir }), /Their change/);
});
