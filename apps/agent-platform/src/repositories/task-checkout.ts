import { access, appendFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "../sandbox/workspace.ts";
import { git, type GitOptions } from "./git.ts";
import type { Repository } from "./repository-catalog.ts";

// A task's repository checkout, split in two:
//
//   work tree  <workspacesDir>/<taskId>                the Workspace: worker edits it, sandbox mounts it
//   git dir    <workspacesDir>/.git-dirs/<taskId>.git  host only: history, refs, config, hooks
//
// Why split: if .git sat in the work tree, sandboxed code could write
// .git/config (core.fsmonitor, filters, aliases...) or a hook, and the next
// `git status` or `git commit` the HOST runs would execute it outside the
// sandbox. With the git dir out of reach, everything the sandbox can touch is
// plain file content to git.
//
// The worker works on branch agent/<taskId>, created from the base branch at
// clone time. The platform commits on its behalf after each attempt; nothing
// runs git inside the sandbox.

const AUTHOR = { "user.name": "Agent Platform", "user.email": "agent-platform@localhost" };
const BASE_REF = "refs/agent/base";

export class TaskCheckout {
  readonly repository: Repository;
  readonly branch: string;
  readonly #gitDir: string;
  readonly #workTree: string;

  private constructor(repository: Repository, gitDir: string, workTree: string, branch: string) {
    this.repository = repository;
    this.#gitDir = gitDir;
    this.#workTree = workTree;
    this.branch = branch;
  }

  /**
   * Returns the task's checkout, cloning it on first use. Later attempts
   * (revisions) reuse it, so they build on earlier commits.
   */
  static async prepare(options: {
    repository: Repository;
    workspace: Workspace;
    workspacesDir: string;
    taskId: string;
    auth?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<{ checkout: TaskCheckout; cloned: boolean }> {
    const { repository, workspace, workspacesDir, taskId, auth, signal } = options;
    const gitDir = gitDirFor(workspacesDir, taskId);
    const checkout = new TaskCheckout(repository, gitDir, workspace.root, `agent/${taskId}`);
    if (await exists(gitDir)) return { checkout, cloned: false };

    if ((await readdir(workspace.root)).length > 0) {
      throw new Error(`Workspace of ${taskId} is not empty; can't clone into it`);
    }
    await mkdir(path.dirname(gitDir), { recursive: true });
    const branchArgs = repository.baseBranch ? ["--branch", repository.baseBranch] : [];
    await git(
      ["clone", "--quiet", "--separate-git-dir", gitDir, "--single-branch", "--no-recurse-submodules",
        ...branchArgs, "--", repository.url, workspace.root],
      { config: auth, signal },
    );
    // The clone leaves a ".git" pointer file in the work tree. Remove it: the
    // sandbox shouldn't even learn where the git dir is, and every host-side
    // git call names the git dir explicitly anyway.
    await rm(path.join(workspace.root, ".git"));

    const baseBranch = (await checkout.#git(["symbolic-ref", "--short", "HEAD"])).trim();
    await checkout.#git(["config", "agent.baseBranch", baseBranch]);
    await checkout.#git(["update-ref", BASE_REF, "HEAD"]);
    await checkout.#git(["checkout", "--quiet", "-b", checkout.branch]);
    // Never commit dependencies a sandboxed `npm install` drops in the work tree.
    await appendFile(path.join(gitDir, "info", "exclude"), "node_modules/\n");
    return { checkout, cloned: true };
  }

  /** Opens an existing checkout (e.g. to publish it); fails if the task never cloned one. */
  static async open(options: { repository: Repository; workspacesDir: string; taskId: string }): Promise<TaskCheckout> {
    const gitDir = gitDirFor(options.workspacesDir, options.taskId);
    if (!(await exists(gitDir))) throw new Error(`Task ${options.taskId} has no repository checkout`);
    const workTree = path.join(options.workspacesDir, options.taskId);
    return new TaskCheckout(options.repository, gitDir, workTree, `agent/${options.taskId}`);
  }

  async baseBranch(): Promise<string> {
    return (await this.#git(["config", "--get", "agent.baseBranch"])).trim();
  }

  /** Commits everything in the work tree. Returns the short commit id, or undefined if nothing changed. */
  async commitAll(message: string): Promise<string | undefined> {
    await this.#git(["add", "--all"]);
    if (!(await this.#git(["status", "--porcelain"])).trim()) return undefined;
    await this.#git(["commit", "--quiet", "--no-verify", "-m", message], { config: AUTHOR });
    return (await this.#git(["rev-parse", "--short", "HEAD"])).trim();
  }

  /** `git diff --stat` of the task branch against where it started. */
  async changeSummary(): Promise<string> {
    return (await this.#git(["diff", "--stat", `${BASE_REF}..HEAD`])).trimEnd();
  }

  /** Pushes the task branch. Never forces: a diverged remote branch is an error, not overwritten. */
  async push(options: { auth?: Record<string, string>; signal?: AbortSignal } = {}): Promise<void> {
    await this.#git(["push", "--quiet", "origin", `${this.branch}:refs/heads/${this.branch}`], {
      config: options.auth,
      signal: options.signal,
    });
  }

  #git(args: string[], options: Omit<GitOptions, "gitDir" | "workTree"> = {}): Promise<string> {
    return git(args, { ...options, gitDir: this.#gitDir, workTree: this.#workTree });
  }
}

function gitDirFor(workspacesDir: string, taskId: string): string {
  // ".git-dirs" can't collide with a workspace: workspace names never start with a dot.
  return path.join(workspacesDir, ".git-dirs", `${taskId}.git`);
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}
