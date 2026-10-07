import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { git, GitError, tokenAuth } from "../src/repositories/git.ts";
import { parseRepositories, RepositoryCatalog } from "../src/repositories/repository-catalog.ts";

test("git runs with a clean, hardened configuration, whatever the host has", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "git-test-"));
  await git(["init", "-q"], { cwd: repo });
  // Host-level config injected through the environment must not leak in.
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "from-host" });
  try {
    await assert.rejects(git(["config", "--get", "user.name"], { cwd: repo }), GitError);
  } finally {
    process.env = saved;
  }
  assert.equal((await git(["config", "--get", "core.hooksPath"], { cwd: repo })).trim(), "/dev/null");
  assert.equal((await git(["config", "--get", "core.fsmonitor"], { cwd: repo })).trim(), "false");
});

test("credentials are per-command config, never written to the repository", async () => {
  const repo = await mkdtemp(path.join(tmpdir(), "git-test-"));
  await git(["init", "-q"], { cwd: repo });

  const header = await git(["config", "--get", "http.extraHeader"], { cwd: repo, config: tokenAuth("abc") });
  assert.equal(header.trim(), `Authorization: Basic ${Buffer.from("x-access-token:abc").toString("base64")}`);
  await assert.rejects(git(["config", "--get", "http.extraHeader"], { cwd: repo })); // gone afterwards
  assert.deepEqual(tokenAuth(undefined), {});
});

test("REPOSITORIES parsing: names, base branches, and no credentials in URLs", () => {
  assert.deepEqual(
    parseRepositories("playground=https://github.com/aheua10/playground.git, api=https://example.com/api.git#develop"),
    [
      { name: "playground", url: "https://github.com/aheua10/playground.git" },
      { name: "api", url: "https://example.com/api.git", baseBranch: "develop" },
    ],
  );
  assert.deepEqual(parseRepositories(undefined), []);
  assert.throws(() => parseRepositories("Bad Name=https://x"), /Invalid REPOSITORIES entry/);
  assert.throws(() => parseRepositories("x=https://user:token@github.com/a/b.git"), /set GIT_TOKEN instead/);
  assert.throws(() => new RepositoryCatalog([{ name: "a", url: "u" }, { name: "a", url: "v" }]), /Duplicate/);
});
