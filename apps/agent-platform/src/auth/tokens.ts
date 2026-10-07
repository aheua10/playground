import { createHash, randomBytes } from "node:crypto";

// API tokens.
//
// A token is 32 random bytes (base64url) behind an "ap_" prefix, so people and
// secret scanners can tell what a leaked string is. The server never stores
// tokens, only their SHA-256 hashes (AUTH_TOKENS), so its configuration, a
// config dump or a log line can't be replayed to get in.
//
// SHA-256, not bcrypt/argon2: those slow hashes protect low-entropy passwords
// from guessing. A 256-bit random token can't be guessed either way, and a
// fast hash keeps every request cheap.

export const TOKEN_PREFIX = "ap_";

/** Who a token belongs to: lowercase letters, digits, "-" and "_". Never contains "/" (see scopeConversationId). */
export const PRINCIPAL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
