import { exec, execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { normalizeRepositoryRelativePath } from "./workspace-path";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
export const MAX_OUTPUT_BYTES = 512_000;
export const MAX_FILE_BYTES = 1_000_000;

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
};

export function resolveWorkspacePath(root: string, requested: string) {
  const relative = normalizeRepositoryRelativePath(requested);
  const resolved = path.resolve(root, relative);
  const boundary = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(boundary)) throw new Error("Path escapes the workspace root.");
  return { relative, resolved };
}

export async function listWorkspace(root: string, requested = ".", depth = 4) {
  const base = requested === "." ? path.resolve(root) : resolveWorkspacePath(root, requested).resolved;
  const ignored = new Set([".git", "node_modules", "dist", ".next", ".vinext", ".wrangler"]);
  async function walk(directory: string, level: number): Promise<unknown[]> {
    if (level > Math.min(Math.max(depth, 1), 8)) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    const result: unknown[] = [];
    for (const entry of entries.slice(0, 500)) {
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) continue;
      result.push({
        path: relative,
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        ...(entry.isDirectory() ? { children: await walk(absolute, level + 1) } : {}),
      });
    }
    return result;
  }
  return walk(base, 1);
}

export async function readWorkspaceFile(root: string, requested: string) {
  const target = resolveWorkspacePath(root, requested);
  const metadata = await stat(target.resolved);
  if (!metadata.isFile()) throw new Error("Requested path is not a file.");
  if (metadata.size > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MB read limit.");
  return { path: target.relative, content: await readFile(target.resolved, "utf8"), size: metadata.size };
}

export async function writeWorkspaceFiles(root: string, files: unknown) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 32) {
    throw new Error("files must contain 1 to 32 items.");
  }
  const written: string[] = [];
  let totalBytes = 0;
  for (const item of files) {
    if (!item || typeof item !== "object") throw new Error("Each file must be an object.");
    const value = item as Record<string, unknown>;
    if (typeof value.path !== "string" || typeof value.content !== "string") {
      throw new Error("Each file requires string path and content fields.");
    }
    const bytes = Buffer.byteLength(value.content, "utf8");
    totalBytes += bytes;
    if (bytes > MAX_FILE_BYTES || totalBytes > 4_000_000) throw new Error("File write limit exceeded.");
    const target = resolveWorkspacePath(root, value.path);
    await mkdir(path.dirname(target.resolved), { recursive: true });
    await writeFile(target.resolved, value.content, "utf8");
    written.push(target.relative);
  }
  return written;
}

export async function deleteWorkspacePaths(root: string, paths: unknown) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 32) {
    throw new Error("paths must contain 1 to 32 items.");
  }
  const deleted: string[] = [];
  for (const item of paths) {
    if (typeof item !== "string") throw new Error("paths must contain strings.");
    const target = resolveWorkspacePath(root, item);
    await rm(target.resolved, { recursive: true, force: false });
    deleted.push(target.relative);
  }
  return deleted;
}

export async function runShell(root: string, input: Record<string, unknown>): Promise<ProcessResult> {
  if (process.env.CONDUCTOR_EXECUTION_MODE !== "container" && process.env.CONDUCTOR_ALLOW_HOST_EXECUTION !== "true") {
    throw new Error("Generic terminal execution is disabled outside the container. Use Docker Compose or set CONDUCTOR_ALLOW_HOST_EXECUTION=true explicitly.");
  }
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command || command.length > 4_000 || command.includes("\0")) throw new Error("command is invalid.");
  const cwdInput = typeof input.cwd === "string" && input.cwd !== "." ? input.cwd : undefined;
  const cwd = cwdInput ? resolveWorkspacePath(root, cwdInput).resolved : root;
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 30_000, 100), 300_000);
  const started = Date.now();
  try {
    const result = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0", PAGER: "cat", GIT_PAGER: "cat" },
    });
    return { ...result, exitCode: 0, timedOut: false, durationMs: Date.now() - started };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      timedOut: Boolean(failure.killed) || /timed out/i.test(failure.message),
      durationMs: Date.now() - started,
    };
  }
}

export async function runGit(root: string, args: string[], timeout = 60_000) {
  return execFileAsync("git", args, {
    cwd: root,
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat" },
  });
}
