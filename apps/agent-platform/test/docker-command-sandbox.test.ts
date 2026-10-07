import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DockerCommandSandbox } from "../src/sandbox/docker-command-sandbox.ts";
import { Workspace } from "../src/sandbox/workspace.ts";
import { eventually } from "./helpers.ts";

// Integration tests against a real Docker daemon: they prove the isolation
// flags actually isolate. They need Docker and the image; without them they
// are reported as skipped (with the reason), not silently passed.

const IMAGE = "node:24-slim";
const dockerReady = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
const requiresDocker = { skip: dockerReady ? false : `needs a Docker daemon and ${IMAGE} pulled`, timeout: 60_000 };

async function setup(options: { timeoutMs?: number } = {}) {
  const workspace = await Workspace.open(await mkdtemp(path.join(tmpdir(), "sandbox-test-")), "task_sandbox");
  const sandbox = new DockerCommandSandbox({ image: IMAGE, network: "none", ...options });
  const run = (command: string, signal = new AbortController().signal) => sandbox.run(workspace, command, { signal });
  return { workspace, sandbox, run };
}

function sandboxContainers(): string {
  return spawnSync("docker", ["ps", "-aq", "--filter", "name=agent-sandbox-"], { encoding: "utf8" }).stdout.trim();
}

test("runs commands against the workspace and keeps their file changes", requiresDocker, async () => {
  const { workspace, sandbox, run } = await setup();
  await sandbox.verify();
  await workspace.writeFile("hello.txt", "from the host");

  const result = await run(`cat hello.txt && node -e "require('fs').writeFileSync('out.txt', 'from the sandbox')"`);

  assert.deepEqual(result, { exitCode: 0, timedOut: false, output: "from the host" });
  assert.equal(await workspace.readFile("out.txt"), "from the sandbox");
  assert.equal((await run("exit 3")).exitCode, 3);
});

test("is isolated: no network, no secrets, no capabilities, read-only system", requiresDocker, async () => {
  const { run } = await setup();
  process.env.SANDBOX_TEST_SECRET = "s3cr3t-value";

  const network = await run(
    `node -e "fetch('http://1.1.1.1').then(() => console.log('ONLINE'), () => console.log('OFFLINE'))"`,
  );
  assert.equal(network.output.trim(), "OFFLINE");
  assert.doesNotMatch((await run("env")).output, /s3cr3t-value|ANTHROPIC/);
  assert.match((await run("grep CapEff /proc/self/status")).output, /CapEff:\s+0+\s*$/);
  assert.notEqual((await run("touch /usr/local/planted")).exitCode, 0);
});

test("stops runaway commands: timeout and cancellation remove the container", requiresDocker, async () => {
  const { run } = await setup({ timeoutMs: 1_500 });

  const startedAt = Date.now();
  const timedOut = await run("sleep 60");
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.exitCode, null);
  assert.ok(Date.now() - startedAt < 15_000);

  const controller = new AbortController();
  const pending = run("sleep 60", controller.signal);
  setTimeout(() => controller.abort(new Error("task cancelled")), 500);
  await assert.rejects(pending, /task cancelled/);

  await eventually(() => sandboxContainers() === "", 10_000);
});
