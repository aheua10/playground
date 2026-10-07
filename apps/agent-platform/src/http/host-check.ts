import { isIP } from "node:net";

// DNS-rebinding defence for every request on our port, REST and WebSocket alike.
//
// The attack: you open a malicious page at evil.example. Its DNS record then
// switches to 127.0.0.1, so the page's later requests to evil.example:3000
// reach this server (say, through the SSM tunnel), and the browser treats them
// as same-origin: no CORS, no preflight. They still say who they think they
// are talking to: "Host: evil.example:3000". So we only answer to host names
// we know.
//
// Always allowed, because no other site can make a browser send them:
//   - localhost
//   - IP addresses: a page served from an IP address is that address's own
//     page, not a rebinding (and load balancer health checks use the IP)
// Any other name (e.g. a DNS name for the instance) must be in ALLOWED_HOSTS.
// The port is ignored: rebinding is about the name, and tunnels and port
// mappings often change the port.

export function isAllowedHost(hostHeader: string | undefined, allowedHostnames: ReadonlySet<string>): boolean {
  const hostname = hostnameOf(hostHeader);
  if (hostname === undefined) return false;
  return hostname === "localhost" || isIP(hostname.replace(/^\[(.*)\]$/, "$1")) !== 0 || allowedHostnames.has(hostname);
}

/** The lower-cased hostname of a Host header value ("Example.com:3000" -> "example.com"), if it is well-formed. */
export function hostnameOf(host: string | undefined): string | undefined {
  if (!host || !URL.canParse(`http://${host}`)) return undefined;
  const url = new URL(`http://${host}`);
  // Only host[:port]: anything else (a path, credentials) isn't a Host header.
  if (url.host !== host.toLowerCase().replace(/:80$/, "")) return undefined;
  return url.hostname;
}
