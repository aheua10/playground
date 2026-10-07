import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "../tools/tool.ts";

// A task's working directory: the filesystem boundary for the coding worker.
//
// Every path the model supplies goes through #resolve, which refuses anything
// that could reach outside the workspace:
//   - absolute paths and ".." segments
//   - symlinks anywhere along the path. Sandboxed commands can create them
//     (ln -s /etc x), and following one from the host would escape.
// Files are opened with O_NOFOLLOW, so the last path component can't be a
// symlink either. No race between check and use: sandboxed commands only run
// between file operations, never during one.
//
// Sizes and counts are capped so a runaway model can't fill the disk or its
// own context window.

export const MAX_FILE_BYTES = 256 * 1024;
const MAX_LISTED_FILES = 500;
/** Listed as a single entry instead of walked: huge and rarely what the model needs. */
const OPAQUE_DIRS = new Set(["node_modules", ".git"]);

export interface WorkspaceFile {
  path: string;
  bytes: number;
}

export class Workspace {
  /** Absolute and symlink-free. */
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /** Opens (creating if needed) the workspace `<baseDir>/<name>`. */
  static async open(baseDir: string, name: string): Promise<Workspace> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`Invalid workspace name "${name}"`);
    await mkdir(baseDir, { recursive: true });
    const root = path.join(await realpath(baseDir), name);
    await mkdir(root, { recursive: true });
    return new Workspace(root);
  }

  async readFile(relativePath: string): Promise<string> {
    const target = await this.#resolve(relativePath, { createParents: false });
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
      throw toToolError(error, relativePath);
    });
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new ToolError(`${relativePath} is not a file.`);
      if (stats.size > MAX_FILE_BYTES) throw new ToolError(`${relativePath} is larger than ${MAX_FILE_BYTES} bytes.`);
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  /** Creates or overwrites a file, creating parent directories. Returns the size in bytes. */
  async writeFile(relativePath: string, content: string): Promise<number> {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new ToolError(`Content is larger than ${MAX_FILE_BYTES} bytes.`);
    const target = await this.#resolve(relativePath, { createParents: true });
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
    const handle = await open(target, flags, 0o644).catch((error) => {
      throw toToolError(error, relativePath);
    });
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    return bytes;
  }

  /** Deletes a file (or a symlink itself, never its target). */
  async deleteFile(relativePath: string): Promise<void> {
    const target = await this.#resolve(relativePath, { createParents: false });
    const stats = await lstat(target).catch((error) => {
      throw toToolError(error, relativePath);
    });
    if (stats.isDirectory()) throw new ToolError(`${relativePath} is a directory; only files can be deleted.`);
    await rm(target);
  }

  /** All files, depth-first in name order. Symlinks are skipped, never followed. */
  async listFiles(): Promise<{ files: WorkspaceFile[]; truncated: boolean }> {
    const files: WorkspaceFile[] = [];
    let truncated = false;

    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= MAX_LISTED_FILES) {
          truncated = true;
          return;
        }
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (OPAQUE_DIRS.has(entry.name)) files.push({ path: `${relative}/`, bytes: 0 });
          else await walk(absolute, relative);
        } else if (entry.isFile()) {
          files.push({ path: relative, bytes: (await lstat(absolute)).size });
        }
      }
    };

    await walk(this.root, "");
    return { files, truncated };
  }

  // Maps a model-supplied relative path to an absolute path inside the
  // workspace, checking every existing directory on the way.
  async #resolve(relativePath: string, options: { createParents: boolean }): Promise<string> {
    if (relativePath.length === 0 || relativePath.includes("\0")) throw new ToolError("Invalid path.");
    if (path.isAbsolute(relativePath)) throw new ToolError("Paths must be relative to the workspace root.");
    const segments = path
      .normalize(relativePath)
      .split(path.sep)
      .filter((segment) => segment !== "" && segment !== ".");
    if (segments.length === 0 || segments.includes("..")) {
      throw new ToolError(`Path is outside the workspace: ${relativePath}`);
    }

    let current = this.root;
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      const stats = await lstat(current).catch(() => undefined);
      if (!stats) {
        if (!options.createParents) throw new ToolError(`${relativePath} does not exist.`);
        await mkdir(current); // one level at a time, so every level is checked
      } else if (stats.isSymbolicLink()) {
        throw new ToolError(`Refusing to follow a symlink in ${relativePath}.`);
      } else if (!stats.isDirectory()) {
        throw new ToolError(`${segment} in ${relativePath} is not a directory.`);
      }
    }
    return path.join(current, segments.at(-1)!);
  }
}

function toToolError(error: unknown, relativePath: string): unknown {
  switch ((error as NodeJS.ErrnoException).code) {
    case "ENOENT":
      return new ToolError(`${relativePath} does not exist.`);
    case "ELOOP":
      return new ToolError(`Refusing to follow a symlink: ${relativePath}.`);
    case "EISDIR":
      return new ToolError(`${relativePath} is a directory.`);
    default:
      return error; // unexpected: let the executor log it and hide the details
  }
}
