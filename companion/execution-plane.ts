import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { normalizeRepositoryRelativePath } from "./workspace-path";

const execFileAsync = promisify(execFile);
export const MAX_OUTPUT_BYTES = 512_000;
export const MAX_FILE_BYTES = 1_000_000;

function isSensitiveWorkspacePath(relativePath: string) {
  return relativePath.split("/").some((segment) =>
    segment === ".env" ||
    (segment.startsWith(".env.") && segment !== ".env.example") ||
    segment.startsWith("secret.") ||
    segment === ".git",
  );
}

function requireNonSensitiveWorkspacePath(relativePath: string) {
  if (isSensitiveWorkspacePath(relativePath)) {
    throw new Error("Sensitive environment, secret, and Git-internal paths are not exposed through the companion.");
  }
}

export type ProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
};

export type ProcessBatchResult = {
  results: Array<ProcessResult & { command: string }>;
};

/**
 * The container runtime installs Python as `python3`. Normalize only a leading
 * standalone `python` executable so reviewed arguments and shell syntax remain
 * unchanged.
 */
export function normalizeRuntimeCommand(command: string) {
  const normalized = command.trim().replace(/^python(?=\s|$)/i, "python3");
  parseBoundedCommand(normalized);
  return normalized;
}

type BoundedCommand = { executable: "node" | "npm" | "python3" | "git" | "tsc"; args: string[] };

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/.test(character)) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += character;
  }
  if (escaped || quote || current.length === 0 && tokens.length === 0) throw new Error("Command quoting is invalid.");
  if (current) tokens.push(current);
  return tokens;
}

function isWorkspaceRelativeScript(value: string) {
  return value.length <= 240 && !value.startsWith("-") && !path.isAbsolute(value) && !value.includes("\\") && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function parseBoundedCommand(command: string): BoundedCommand {
  if (command.length > 4_000 || command.includes("\0")) {
    throw new Error("Command exceeds the execution policy.");
  }
  const [executable, ...args] = tokenizeCommand(command);
  if (executable === "node") {
    if (!(args.length >= 1 && isWorkspaceRelativeScript(args[0]))) throw new Error("Node execution requires a workspace-relative script.");
    return { executable, args };
  }
  if (executable === "npm") {
    if (!((args[0] === "test" && args.length === 1) || (args[0] === "run" && args.length === 2 && /^[A-Za-z0-9:_-]{1,120}$/.test(args[1] ?? "")))) throw new Error("Only npm test or a named npm run script is allowed.");
    return { executable, args };
  }
  if (executable === "python3") {
    if (!args[0] || !isWorkspaceRelativeScript(args[0])) throw new Error("Python execution requires a workspace-relative script.");
    return { executable, args };
  }
  if (executable === "tsc") {
    if (!args.every((arg) => arg === "--noEmit" || arg === "-p" || isWorkspaceRelativeScript(arg))) throw new Error("TypeScript execution is outside the bounded policy.");
    return { executable, args };
  }
  if (executable === "git") {
    const verb = args[0];
    if (!verb || !new Set(["status", "diff", "log", "show", "branch", "rev-parse"]).has(verb)) {
      throw new Error("Remote Git commands, aliases, and publication commands are permanently retired.");
    }
    return { executable, args };
  }
  throw new Error("Executable is not in the bounded execution allowlist.");
}

async function assertNpmLifecycleSafe(root: string, args: string[]): Promise<void> {
  const scriptName = args[0] === "test" ? "test" : args[1];
  if (!scriptName) throw new Error("npm script is invalid.");
  let packageJson: { scripts?: Record<string, unknown> };
  try {
    packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
  } catch {
    throw new Error("npm execution requires a readable workspace package.json.");
  }
  for (const name of [`pre${scriptName}`, scriptName, `post${scriptName}`]) {
    const script = packageJson.scripts?.[name];
    if (script === undefined) continue;
    if (typeof script !== "string") throw new Error("npm script is invalid.");
    if (/(?:\bgit\s+(?:push|send-pack|remote|fetch|pull|clone)\b|\b(?:curl|wget|npx|npm\s+(?:exec|publish|install)|ssh|scp|ftp)\b|\b(?:sh|bash|zsh|cmd|powershell|pwsh)\b|https?:\/\/)/i.test(script)) {
      throw new Error("npm lifecycle script is outside the bounded no-publication/no-network policy.");
    }
  }
}

function boundedEnvironment(safeDirectory?: string): NodeJS.ProcessEnv {
  // Do not inherit provider, GitHub, PAT, proxy, or caller-supplied credential
  // variables into a reviewed child process.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? process.env.TEMP,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: "production",
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    ...(safeDirectory ? {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: safeDirectory,
    } : {}),
    GIT_PAGER: "cat",
    PAGER: "cat",
  };
}

export function resolveWorkspacePath(root: string, requested: string) {
  const relative = normalizeRepositoryRelativePath(requested);
  const resolved = path.resolve(root, relative);
  const boundary = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(boundary)) throw new Error("Path escapes the workspace root.");
  return { relative, resolved };
}

export async function listWorkspace(root: string, requested = ".", depth = 4) {
  const base = requested === "." ? path.resolve(root) : resolveWorkspacePath(root, requested).resolved;
  const ignored = new Set([".git", ".conductor", "node_modules", "dist", ".next", ".vinext", ".wrangler"]);
  const isSensitiveOrGenerated = (name: string) =>
    name === ".env" ||
    (name.startsWith(".env.") && name !== ".env.example") ||
    name.startsWith("secret.") ||
    name.endsWith(".tar.gz") ||
    name === "tsconfig.tsbuildinfo";
  async function walk(directory: string, level: number): Promise<unknown[]> {
    if (level > Math.min(Math.max(depth, 1), 8)) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    const result: unknown[] = [];
    for (const entry of entries.slice(0, 500)) {
      if (ignored.has(entry.name) || isSensitiveOrGenerated(entry.name)) continue;
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
  requireNonSensitiveWorkspacePath(target.relative);
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
    requireNonSensitiveWorkspacePath(target.relative);
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
    requireNonSensitiveWorkspacePath(target.relative);
    await rm(target.resolved, { recursive: true, force: false });
    deleted.push(target.relative);
  }
  return deleted;
}

export async function runShell(root: string, input: Record<string, unknown>): Promise<ProcessResult> {
  if (process.env.CONDUCTOR_EXECUTION_MODE !== "container" && process.env.CONDUCTOR_ALLOW_HOST_EXECUTION !== "true") {
    throw new Error("Generic terminal execution is disabled outside the container. Use Docker Compose or set CONDUCTOR_ALLOW_HOST_EXECUTION=true explicitly.");
  }
  const command = typeof input.command === "string" ? normalizeRuntimeCommand(input.command) : "";
  if (!command) throw new Error("command is invalid.");
  const parsedCommand = parseBoundedCommand(command);
  const cwdInput = typeof input.cwd === "string" && input.cwd !== "." ? input.cwd : undefined;
  const cwd = cwdInput ? resolveWorkspacePath(root, cwdInput).resolved : root;
  if (parsedCommand.executable === "npm") await assertNpmLifecycleSafe(cwd, parsedCommand.args);
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs) || 30_000, 100), 300_000);
  const started = Date.now();
  try {
    const result = await execFileAsync(parsedCommand.executable, parsedCommand.args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      env: boundedEnvironment(root),
      shell: false,
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

/**
 * Runs a reviewed sequence one command at a time. Each command gets an
 * independent timeout and result record; a non-zero exit never hides the
 * results of later commands. The caller must still supply one approval token
 * bound to the complete commands payload.
 */
export async function runShellBatch(root: string, input: Record<string, unknown>): Promise<ProcessBatchResult> {
  const commands = input.commands;
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 8) {
    throw new Error("commands must contain 1 to 8 reviewed commands.");
  }

  let combinedTimeoutMs = 0;
  const normalized = commands.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Each command must be an object.");
    const value = item as Record<string, unknown>;
    const command = typeof value.command === "string" ? normalizeRuntimeCommand(value.command) : "";
    if (!command || command.length > 4_000 || command.includes("\0")) {
      throw new Error("Each command must be a non-empty bounded command.");
    }
    const timeoutMs = Math.min(Math.max(Number(value.timeoutMs) || 30_000, 100), 300_000);
    combinedTimeoutMs += timeoutMs;
    return {
      command,
      timeoutMs,
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    };
  });
  if (combinedTimeoutMs > 2_400_000) {
    throw new Error("Combined command timeout cannot exceed 2400000 ms.");
  }

  const results: ProcessBatchResult["results"] = [];
  for (const item of normalized) {
    const result = await runShell(root, item);
    results.push({ command: item.command, ...result });
  }
  return { results };
}

export async function runGit(root: string, args: string[], timeout = 60_000) {
  return execFileAsync("git", args, {
    cwd: root,
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    encoding: "utf8",
    env: boundedEnvironment(root),
    shell: false,
  });
}
