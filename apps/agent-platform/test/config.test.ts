import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { hashToken } from "../src/auth/tokens.ts";
import { loadConfig } from "../src/config.ts";

const HASH = hashToken("ap_example");

test("AUTH: tokens by default, and then at least one valid AUTH_TOKENS entry is required", () => {
  assert.throws(() => loadConfig({}), /AUTH_TOKENS is empty/);
  assert.deepEqual(loadConfig({ AUTH_TOKENS: `alice:${HASH}, bob:${HASH}` }).auth, {
    kind: "tokens",
    tokens: [
      { principal: "alice", tokenHash: HASH },
      { principal: "bob", tokenHash: HASH },
    ],
  });
  for (const bad of ["alice", `Alice:${HASH}`, "alice:ap_example", `alice:${HASH}:x`, `a/b:${HASH}`]) {
    assert.throws(
      () => loadConfig({ AUTH_TOKENS: bad }),
      (error: Error) => /Invalid AUTH_TOKENS entry/.test(error.message) && !error.message.includes("ap_example"),
      bad,
    );
  }
  assert.deepEqual(loadConfig({ AUTH: "none" }).auth, { kind: "none" });
  assert.throws(() => loadConfig({ AUTH: "maybe" }), /Invalid AUTH/);
});

test("ALLOWED_HOSTS: host names, lower-cased; none by default", () => {
  assert.deepEqual(loadConfig({ AUTH: "none" }).allowedHosts, []);
  assert.deepEqual(loadConfig({ AUTH: "none", ALLOWED_HOSTS: "Agent.Example.com, agent.internal" }).allowedHosts, [
    "agent.example.com",
    "agent.internal",
  ]);
  for (const bad of ["agent.example.com:3000", "http://agent.example.com", "a b", "agent.example.com/x"]) {
    assert.throws(() => loadConfig({ AUTH: "none", ALLOWED_HOSTS: bad }), /Invalid ALLOWED_HOSTS entry/, bad);
  }
});

test("ALLOWED_ORIGINS: localhost on PORT by default; full origins only", () => {
  assert.deepEqual(loadConfig({ AUTH: "none", PORT: "4000" }).allowedOrigins, ["http://localhost:4000", "http://127.0.0.1:4000"]);
  assert.deepEqual(loadConfig({ AUTH: "none", ALLOWED_ORIGINS: "https://ui.example.com" }).allowedOrigins, ["https://ui.example.com"]);
  for (const bad of ["ui.example.com", "https://ui.example.com/", "https://ui.example.com/app"]) {
    assert.throws(() => loadConfig({ AUTH: "none", ALLOWED_ORIGINS: bad }), /Invalid ALLOWED_ORIGINS entry/, bad);
  }
});

test("STORE: SQLite at ./data by default, or in memory", () => {
  assert.deepEqual(loadConfig({ AUTH: "none" }).store, {
    kind: "sqlite",
    path: path.resolve("data/agent-platform.db"),
  });
  assert.deepEqual(loadConfig({ AUTH: "none", DATABASE_PATH: "/srv/agent/db.sqlite" }).store, {
    kind: "sqlite",
    path: "/srv/agent/db.sqlite",
  });
  assert.deepEqual(loadConfig({ AUTH: "none", STORE: "memory" }).store, { kind: "memory" });
  assert.throws(() => loadConfig({ AUTH: "none", STORE: "postgres" }), /Invalid STORE/);
});
