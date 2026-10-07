import { hashToken } from "./tokens.ts";

// Authentication: who is making this request?
//
// Transports extract the credential (a bearer token today) and ask an
// Authenticator who it belongs to. The answer is a Principal, or nobody.
// Authenticators are pluggable: tokens now; an OIDC/JWT authenticator for a
// browser UI with real sign-in would implement the same interface.
//
// Authorization follows from the principal: every conversation id a client
// sends is scoped to its principal (scopeConversationId), so users can't see
// or touch each other's conversations, and therefore not each other's tasks.

export interface Principal {
  id: string;
}

export interface Authenticator {
  /** Mode name for logs: "tokens", "none". */
  readonly kind: string;
  /** Who presented this bearer token, or undefined if nobody we know (or no token at all). */
  authenticate(token: string | undefined): Principal | undefined;
}

export interface TokenEntry {
  principal: string;
  tokenHash: string;
}

export class TokenAuthenticator implements Authenticator {
  readonly kind = "tokens";
  readonly #byHash: Map<string, Principal>;

  constructor(entries: readonly TokenEntry[]) {
    // One principal may have several tokens (one per device, or old and new while rotating).
    this.#byHash = new Map(entries.map((entry) => [entry.tokenHash, { id: entry.principal }]));
  }

  authenticate(token: string | undefined): Principal | undefined {
    // A lookup by hash: an attacker timing it learns about hashes, which says
    // nothing useful about any token.
    return token ? this.#byHash.get(hashToken(token)) : undefined;
  }

  /** The principals that have tokens, for the startup log. */
  principals(): string[] {
    return [...new Set([...this.#byHash.values()].map((principal) => principal.id))].sort();
  }
}

/** AUTH=none: everybody is the same local user. For a machine only you can reach. */
export class NoAuthenticator implements Authenticator {
  readonly kind = "none";

  authenticate(): Principal {
    return { id: "local" };
  }
}

/** The token from an "Authorization: Bearer <token>" header. */
export function bearerToken(authorization: string | undefined): string | undefined {
  return /^Bearer +(\S+) *$/i.exec(authorization ?? "")?.[1];
}

/**
 * The id a conversation is stored under: the client's id inside the
 * principal's namespace. Alice's "demo" and Bob's "demo" are different
 * conversations, so isolation needs no ownership checks that could be
 * forgotten: everything keyed by conversation id (history, tasks, events,
 * turn locks) is per-user by construction. Unambiguous because principal ids
 * never contain "/" and conversation ids never do either.
 */
export function scopeConversationId(principal: Principal, conversationId: string): string {
  return `${principal.id}/${conversationId}`;
}
