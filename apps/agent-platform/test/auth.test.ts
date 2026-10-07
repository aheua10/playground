import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bearerToken,
  NoAuthenticator,
  scopeConversationId,
  TokenAuthenticator,
} from "../src/auth/authenticator.ts";
import { generateToken, hashToken, PRINCIPAL_ID_PATTERN, TOKEN_HASH_PATTERN } from "../src/auth/tokens.ts";

test("tokens are random, prefixed, and stored only as SHA-256 hashes", () => {
  const [a, b] = [generateToken(), generateToken()];
  assert.match(a, /^ap_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.match(hashToken(a), TOKEN_HASH_PATTERN);
  assert.equal(hashToken(a), hashToken(a));
  assert.notEqual(hashToken(a), hashToken(b));
});

test("TokenAuthenticator: a known token identifies its principal; anything else nobody", () => {
  const [alice, aliceLaptop, bob] = [generateToken(), generateToken(), generateToken()];
  const auth = new TokenAuthenticator([
    { principal: "alice", tokenHash: hashToken(alice) },
    { principal: "alice", tokenHash: hashToken(aliceLaptop) },
    { principal: "bob", tokenHash: hashToken(bob) },
  ]);

  assert.deepEqual(auth.authenticate(alice), { id: "alice" });
  assert.deepEqual(auth.authenticate(aliceLaptop), { id: "alice" });
  assert.deepEqual(auth.authenticate(bob), { id: "bob" });
  for (const token of [undefined, "", generateToken(), hashToken(alice), `${alice} `]) {
    assert.equal(auth.authenticate(token), undefined, String(token));
  }
  assert.deepEqual(auth.principals(), ["alice", "bob"]);
});

test("NoAuthenticator: everybody is the local user", () => {
  assert.deepEqual(new NoAuthenticator().authenticate(), { id: "local" });
});

test("bearerToken reads the Authorization header's bearer token only", () => {
  assert.equal(bearerToken("Bearer ap_abc"), "ap_abc");
  assert.equal(bearerToken("bearer   ap_abc"), "ap_abc");
  for (const header of [undefined, "", "Bearer", "Bearer ", "Basic dXNlcjpwYXNz", "Bearer a b", "ap_abc"]) {
    assert.equal(bearerToken(header), undefined, String(header));
  }
});

test("conversation ids are scoped per principal, without collisions", () => {
  assert.equal(scopeConversationId({ id: "alice" }, "demo"), "alice/demo");
  assert.notEqual(scopeConversationId({ id: "alice" }, "demo"), scopeConversationId({ id: "bob" }, "demo"));
  // No principal id or conversation id contains "/", so "alice" can't name a conversation into bob's space.
  assert.equal(PRINCIPAL_ID_PATTERN.test("alice/bob"), false);
});
