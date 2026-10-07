// The repositories tasks may work on: an allowlist maintained by whoever runs
// the platform (REPOSITORIES), not by the model. The model picks a repository
// BY NAME, and the tool schema only accepts names from this list, so it can
// never make the platform clone, or push to, a URL of its choosing.

export interface Repository {
  /** What the model and the user refer to, e.g. "playground". */
  name: string;
  /** Clone URL, without credentials (see GIT_TOKEN). */
  url: string;
  /** Branch to start from; the remote's default branch if omitted. */
  baseBranch?: string;
}

export class RepositoryCatalog {
  readonly #repositories = new Map<string, Repository>();

  constructor(repositories: Repository[] = []) {
    for (const repository of repositories) {
      if (this.#repositories.has(repository.name)) throw new Error(`Duplicate repository "${repository.name}"`);
      this.#repositories.set(repository.name, repository);
    }
  }

  get(name: string): Repository | undefined {
    return this.#repositories.get(name);
  }

  names(): string[] {
    return [...this.#repositories.keys()].sort();
  }
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Parses REPOSITORIES: comma-separated `name=url` or `name=url#baseBranch`. */
export function parseRepositories(value: string | undefined): Repository[] {
  if (!value?.trim()) return [];
  return value.split(",").map((entry) => {
    const match = /^([^=]+)=([^#]+)(?:#(.+))?$/.exec(entry.trim());
    const name = match?.[1]?.trim() ?? "";
    const url = match?.[2]?.trim() ?? "";
    if (!match || !NAME_PATTERN.test(name) || !url) {
      throw new Error(`Invalid REPOSITORIES entry "${entry}" (expected name=url or name=url#branch)`);
    }
    if (/^[a-z]+:\/\/[^/]*@/i.test(url)) {
      throw new Error(`Repository "${name}": don't put credentials in the URL; set GIT_TOKEN instead`);
    }
    const baseBranch = match[3]?.trim();
    return baseBranch ? { name, url, baseBranch } : { name, url };
  });
}
