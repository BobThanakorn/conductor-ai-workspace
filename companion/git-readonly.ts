import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createActionDigest } from "./action-digest";
import {
  type CommandFailure,
  type CommandResult,
  type CommandSuccess,
  type ReadCapabilityId,
  validateCommandEnvelopeBasics,
} from "./contracts";
import {
  assertGitMarker,
  assertWorkspaceStillCanonical,
  canonicalizeWorkspaceRoot,
  normalizeRepositoryRelativePath,
  WorkspacePathError,
} from "./workspace-path";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 180_000;
const READ_TIMEOUT_MS = 15_000;

type GitStatusInput = { readonly includeUntracked?: boolean };
type GitDiffInput = { readonly paths?: readonly string[]; readonly contextLines?: number };
type GitLogInput = { readonly limit?: number };

type ReadonlyGitCommand =
  | { readonly name: "git.status"; readonly input: GitStatusInput }
  | { readonly name: "git.diff"; readonly input: GitDiffInput }
  | { readonly name: "git.log"; readonly input: GitLogInput };

type ReadonlyGitCommandName = ReadonlyGitCommand["name"];

export async function executeReadOnlyGitCommand(
  rawCommand: unknown,
): Promise<CommandResult<ReadonlyGitCommandName, unknown>> {
  const startedAt = Date.now();
  let commandId = "unknown";
  let evidence: CommandSuccess<ReadonlyGitCommandName, never>["evidence"] | undefined;

  try {
    validateCommandEnvelopeBasics(rawCommand);
    commandId = rawCommand.commandId;
    const now = Date.now();
    const requestedName = isReadonlyGitCommandName(rawCommand.command.name)
      ? rawCommand.command.name
      : "git.status";
    if (Date.parse(rawCommand.expiresAt) <= now) {
      return failure(commandId, requestedName, startedAt, "DEADLINE_EXCEEDED", "Command authorization expired.", false);
    }

    const command = parseCommand(rawCommand.capability, rawCommand.command.name, rawCommand.command.input);
    const canonicalRoot = await canonicalizeWorkspaceRoot(rawCommand.workspace.root);
    await assertWorkspaceStillCanonical(canonicalRoot);
    await assertGitMarker(canonicalRoot);

    const argumentsList = argumentsFor(command);
    evidence = {
      actionDigest: createActionDigest({
        commandId: rawCommand.commandId,
        policyVersion: rawCommand.policyVersion,
        issuedAt: rawCommand.issuedAt,
        expiresAt: rawCommand.expiresAt,
        workspace: {
          canonicalRoot,
          snapshotId: rawCommand.workspace.snapshotId ?? null,
        },
        capability: rawCommand.capability,
        action: { name: command.name, input: command.input },
      }),
      canonicalWorkspaceRoot: canonicalRoot,
      executable: "git",
      arguments: argumentsList,
    };

    const { stdout, stderr } = await execFileAsync("git", argumentsList, {
      cwd: canonicalRoot,
      timeout: READ_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
      } as unknown as NodeJS.ProcessEnv,
    });
    const output = boundedOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`);

    return {
      schemaVersion: "companion.result.v1",
      kind: "companion.result",
      commandId,
      commandName: command.name,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      ok: true,
      value: { output, truncated: output.length >= MAX_OUTPUT_BYTES },
      evidence,
    };
  } catch (error) {
    const commandName = isPlainCommandName(rawCommand) ? rawCommand.command.name : "git.status";
    const details = error instanceof Error ? error.message.slice(0, 300) : "Unknown failure";
    const code = error instanceof WorkspacePathError
      ? "WORKSPACE_INVALID"
      : isTimedOut(error)
        ? "TIMEOUT"
        : isOutputLimitError(error)
          ? "OUTPUT_LIMIT_EXCEEDED"
          : "GIT_FAILED";
    return failure(commandId, commandName, startedAt, code, details, code === "TIMEOUT", evidence);
  }
}

function parseCommand(
  capability: ReadCapabilityId,
  name: string,
  input: unknown,
): ReadonlyGitCommand {
  if (capability === "git.read.status" && name === "git.status") {
    return { name, input: parseStatusInput(input) };
  }
  if (capability === "git.read.diff" && name === "git.diff") {
    return { name, input: parseDiffInput(input) };
  }
  if (capability === "git.read.log" && name === "git.log") {
    return { name, input: parseLogInput(input) };
  }
  throw new Error("Capability and read-only Git command do not match.");
}

function argumentsFor(command: ReadonlyGitCommand): string[] {
  if (command.name === "git.status") {
    return ["--no-optional-locks", "status", "--branch", "--porcelain=v1", ...(command.input.includeUntracked === false ? ["--untracked-files=no"] : [])];
  }
  if (command.name === "git.diff") {
    const contextLines = command.input.contextLines ?? 3;
    const paths = command.input.paths ?? [];
    return [
      "--no-optional-locks",
      "diff",
      "--no-ext-diff",
      `--unified=${contextLines}`,
      ...(paths.length ? ["--", ...paths] : []),
    ];
  }
  return [
    "--no-optional-locks",
    "log",
    "--no-decorate",
    "--date=iso-strict",
    "--format=%H%x09%an%x09%ad%x09%s",
    `-n${command.input.limit ?? 20}`,
  ];
}

function parseStatusInput(value: unknown): GitStatusInput {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "includeUntracked")) throw new Error("Invalid git.status input.");
  if (value.includeUntracked !== undefined && typeof value.includeUntracked !== "boolean") throw new Error("includeUntracked must be boolean.");
  return { includeUntracked: value.includeUntracked as boolean | undefined };
}

function parseDiffInput(value: unknown): GitDiffInput {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "paths" && key !== "contextLines")) throw new Error("Invalid git.diff input.");
  const contextLines = value.contextLines;
  if (contextLines !== undefined && (typeof contextLines !== "number" || !Number.isInteger(contextLines) || contextLines < 0 || contextLines > 12)) throw new Error("contextLines must be an integer from 0 to 12.");
  const rawPaths = value.paths;
  if (rawPaths !== undefined && (!Array.isArray(rawPaths) || rawPaths.length > 32 || rawPaths.some((path) => typeof path !== "string"))) throw new Error("paths must contain at most 32 strings.");
  const paths = Array.isArray(rawPaths)
    ? rawPaths.map((path) => normalizeRepositoryRelativePath(path as string))
    : undefined;
  return { contextLines: contextLines as number | undefined, paths };
}

function parseLogInput(value: unknown): GitLogInput {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "limit")) throw new Error("Invalid git.log input.");
  const limit = value.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)) throw new Error("limit must be an integer from 1 to 50.");
  return { limit: limit as number | undefined };
}

function failure(
  commandId: string,
  commandName: ReadonlyGitCommandName,
  startedAt: number,
  code: CommandFailure<ReadonlyGitCommandName>["error"]["code"],
  message: string,
  retryable: boolean,
  evidence?: CommandSuccess<ReadonlyGitCommandName, never>["evidence"],
): CommandFailure<ReadonlyGitCommandName> {
  return {
    schemaVersion: "companion.result.v1",
    kind: "companion.result",
    commandId,
    commandName,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    ok: false,
    error: { code, message, retryable },
    ...(evidence ? { evidence } : {}),
  };
}

function boundedOutput(value: string): string {
  return value.length > MAX_OUTPUT_BYTES ? value.slice(0, MAX_OUTPUT_BYTES) : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isPlainCommandName(value: unknown): value is { command: { name: ReadonlyGitCommand["name"] } } {
  return isPlainObject(value) && isPlainObject(value.command) &&
    ["git.status", "git.diff", "git.log"].includes(String(value.command.name));
}

function isReadonlyGitCommandName(value: string): value is ReadonlyGitCommandName {
  return value === "git.status" || value === "git.diff" || value === "git.log";
}

function isTimedOut(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { killed?: boolean }).killed === true;
}

function isOutputLimitError(error: unknown): boolean {
  return error instanceof RangeError || (typeof error === "object" && error !== null && (error as { code?: string }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
}
