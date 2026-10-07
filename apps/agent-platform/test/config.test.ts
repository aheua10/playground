import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

test("ALLOWED_HOSTS: host names, lower-cased; none by default", () => {
  assert.deepEqual(loadConfig({}).allowedHosts, []);
  assert.deepEqual(loadConfig({ ALLOWED_HOSTS: "Agent.Example.com, agent.internal" }).allowedHosts, [
    "agent.example.com",
    "agent.internal",
  ]);
  for (const bad of ["agent.example.com:3000", "http://agent.example.com", "a b", "agent.example.com/x"]) {
    assert.throws(() => loadConfig({ ALLOWED_HOSTS: bad }), /Invalid ALLOWED_HOSTS entry/, bad);
  }
});

test("ALLOWED_ORIGINS: localhost on PORT by default; full origins only", () => {
  assert.deepEqual(loadConfig({ PORT: "4000" }).allowedOrigins, ["http://localhost:4000", "http://127.0.0.1:4000"]);
  assert.deepEqual(loadConfig({ ALLOWED_ORIGINS: "https://ui.example.com" }).allowedOrigins, ["https://ui.example.com"]);
  for (const bad of ["ui.example.com", "https://ui.example.com/", "https://ui.example.com/app"]) {
    assert.throws(() => loadConfig({ ALLOWED_ORIGINS: bad }), /Invalid ALLOWED_ORIGINS entry/, bad);
  }
});
