// Creates an API token for the agent.
//
//   npm run create-token -- <name>
//
// Prints the token once, for you, and the AUTH_TOKENS entry for the server,
// which holds only the token's hash. Run it on your own machine: the token
// never needs to exist on the server. No dependencies.

import { generateToken, hashToken, PRINCIPAL_ID_PATTERN } from "../src/auth/tokens.ts";

const name = process.argv[2] ?? "";
if (!PRINCIPAL_ID_PATTERN.test(name)) {
  console.error("Usage: npm run create-token -- <name>   (lowercase letters, digits, - and _)");
  process.exit(1);
}

const token = generateToken();
console.log(`Token for "${name}". It is shown only this once; keep it somewhere safe:

  ${token}

On the server, add this entry to AUTH_TOKENS in .env (comma-separate several):

  AUTH_TOKENS=${name}:${hashToken(token)}

Then use it:

  export AGENT_TOKEN=${token}
  npm run chat
  curl -H "Authorization: Bearer $AGENT_TOKEN" localhost:3000/conversations/demo`);
