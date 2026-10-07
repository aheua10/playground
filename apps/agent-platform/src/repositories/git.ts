import { execFile } from "node:child_process";

// Runs git on the HOST, for what the platform does on a task's behalf: clone,
// commit, push. Model-written code never runs here; it only runs in the
// sandbox. But git's configuration can make git itself run commands, so every
// call is pinned down:
//
//   - argument arrays, never a shell
//   - a clean environment: no system or global config, no credential helpers
//     or askpass from the host, no prompts. Only proxy and CA settings pass
//     through, so git sees exactly what we give it.
//   - hooks and fsmonitor disabled, the ext:: transport forbidden
//   - credentials only as per-command config in the child's environment:
//     never in URLs, argv (visible in `ps`), config files or logs
//
// The other half of the defense: a task's git directory lives outside the
// work tree the sandbox can write to (see task-checkout.ts).

const PASSTHROUGH_ENV = [
  "PATH", "HOME", "LANG",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
  "SSL_CERT_FILE", "GIT_SSL_CAINFO", "CURL_CA_BUNDLE",
];

const HARDENING: Record<string, string> = {
  "core.hooksPath": "/dev/null",
  "core.fsmonitor": "false",
  "protocol.ext.allow": "never",
};

export interface GitOptions {
  gitDir?: string;
  workTree?: string;
  cwd?: string;
  /** Extra config for this one command (e.g. credentials), passed via the environment. */
  config?: Record<string, string>;
  signal?: AbortSignal;
}

export class GitError extends Error {
  override name = "GitError";
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

export function git(args: string[], options: GitOptions = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const name of PASSTHROUGH_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const config = Object.entries({ ...HARDENING, ...options.config });
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  const location = [
    ...(options.gitDir ? [`--git-dir=${options.gitDir}`] : []),
    ...(options.workTree ? [`--work-tree=${options.workTree}`] : []),
  ];
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...location, ...args],
      { env, cwd: options.cwd, signal: options.signal, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        if (options.signal?.aborted) return reject(options.signal.reason);
        const detail = stderr.trim().split("\n").at(-1) ?? error.message;
        reject(new GitError(`git ${args[0]} failed: ${detail}`, stderr));
      },
    );
  });
}

/** Per-command config that authenticates HTTPS git calls with a token (GitHub style). */
export function tokenAuth(token: string | undefined): Record<string, string> {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { "http.extraHeader": `Authorization: Basic ${basic}` };
}
