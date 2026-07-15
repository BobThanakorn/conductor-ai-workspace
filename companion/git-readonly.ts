import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createActionDigest } from "./action-digest";
import {
  ContractValidationError,
  type CommandErrorCode,
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

/** `execFile` applies this ceiling independently to stdout and stderr. */
export const MAX_GIT_STREAM_BYTES = 180_000;
export const READ_TIMEOUT_MS = 15_000;

export type GitStatusInput = { readonly includeUntracked?: boolean };
export type GitDiffInput = {
  readonly paths?: readonly string[];
  readonly contextLines?: number;
};
export type GitLogInput = { readonly limit?: number };

export type ReadonlyGitCommand =
  | { readonly name: "git.status"; readonly input: GitStatusInput }
  | { readonly name: "git.diff"; readonly input: GitDiffInput }
  | { readonly name: "git.log"; readonly input: GitLogInput };

export type ReadonlyGitCommandName = ReadonlyGitCommand["name"];

export interface ReadonlyGitTextResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

export const CAPABILITY_FOR_COMMAND = {
  "git.status": "git.read.status",
  "git.diff": "git.read.diff",
  "git.log": "git.read.log",
} as const satisfies Readonly<Record<ReadonlyGitCommandName, ReadCapabilityId>>;

/**
 * The only process bridge in this foundation. It always calls the literal Git
 * executable with an argument array; it never accepts an executable, verb, or
 * raw command string from the command envelope.
 */
export async function executeReadOnlyGitCommand(
  rawCommand: unknown,
): Promise<CommandResult<ReadonlyGitCommandName, ReadonlyGitTextResult>> {
  const startedAt = Date.now();
  let commandId = "unknown";
  let evidence: CommandSuccess<ReadonlyGitCommandName, never>["evidence"] | undefined;

  try {
    validateCommandEnvelopeBasics(rawCommand);
    commandId = rawCommand.commandId;
    const requestedName = isReadonlyGitCommandName(rawCommand.command.name)
      ? rawCommand.command.name
      : "git.status";
    const remainingMs = Date.parse(rawCommand.expiresAt) - Date.now();
    if (remainingMs <= 0) {
      return failure(
        commandId,
        requestedName,
        startedAt,
        "DEADLINE_EXCEEDED",
        "Command authorization expired.",
        false,
      );
    }

    const command = parseReadOnlyGitCommand(
      rawCommand.capability,
      rawCommand.command.name,
      rawCommand.command.input,
    );
    const canonicalRoot = await canonicalizeWorkspaceRoot(rawCommand.workspace.root);
    await assertGitMarker(canonicalRoot);
    await assertWorkspaceStillCanonical(canonicalRoot);

    const argumentsList = buildReadOnlyGitArguments(command);
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
      timeout: Math.min(READ_TIMEOUT_MS, remainingMs),
      windowsHide: true,
      maxBuffer: MAX_GIT_STREAM_BYTES,
      encoding: "utf8",
      env: gitEnvironment(),
      shell: false,
    });
    await assertWorkspaceStillCanonical(canonicalRoot);

    return {
      schemaVersion: "companion.result.v1",
      kind: "companion.result",
      commandId,
      commandName: command.name,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      ok: true,
      value: {
        stdout,
        stderr,
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
      },
      evidence,
    };
  } catch (error) {
    const commandName = isPlainCommandName(rawCommand)
      ? rawCommand.command.name
      : "git.status";
    const classified = classifyError(error);
    return failure(
      commandId,
      commandName,
      startedAt,
      classified.code,
      classified.message,
      classified.retryable,
      evidence,
    );
  }
}

export function parseReadOnlyGitCommand(
  capability: ReadCapabilityId,
  name: string,
  input: unknown,
): ReadonlyGitCommand {
  if (!isReadonlyGitCommandName(name) || CAPABILITY_FOR_COMMAND[name] !== capability) {
    throw new ReadonlyGitBridgeError(
      "CAPABILITY_MISMATCH",
      "Capability and read-only Git command do not match.",
    );
  }
  switch (name) {
    case "git.status":
      return { name, input: parseStatusInput(input) };
    case "git.diff":
      return { name, input: parseDiffInput(input) };
    case "git.log":
      return { name, input: parseLogInput(input) };
  }
}

export function buildReadOnlyGitArguments(command: ReadonlyGitCommand): string[] {
  const fixedPrefix = [
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "color.ui=false",
  ];

  switch (command.name) {
    case "git.status":
      return [
        ...fixedPrefix,
        "status",
        "--branch",
        "--porcelain=v2",
        "-z",
        ...(command.input.includeUntracked === false
          ? ["--untracked-files=no"]
          : ["--untracked-files=all"]),
      ];
    case "git.diff": {
      const paths = command.input.paths ?? [];
      return [
        ...fixedPrefix,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--submodule=short",
        `--unified=${command.input.contextLines ?? 3}`,
        ...(paths.length > 0 ? ["--", ...paths] : []),
      ];
    }
    case "git.log":
      return [
        ...fixedPrefix,
        "log",
        "--no-decorate",
        "--date=iso-strict",
        "--format=%H%x09%an%x09%ad%x09%s",
        `--max-count=${command.input.limit ?? 20}`,
      ];
  }
}

function parseStatusInput(value: unknown): GitStatusInput {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "includeUntracked")) {
    throw new ContractValidationError("Invalid git.status input.");
  }
  if (value.includeUntracked !== undefined && typeof value.includeUntracked !== "boolean") {
    throw new ContractValidationError("includeUntracked must be boolean.");
  }
  return value.includeUntracked === undefined
    ? {}
    : { includeUntracked: value.includeUntracked as boolean };
}

function parseDiffInput(value: unknown): GitDiffInput {
  if (value === undefined || value === null) return {};
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => key !== "paths" && key !== "contextLines")
  ) {
    throw new ContractValidationError("Invalid git.diff input.");
  }
  const contextLines = value.contextLines;
  if (
    contextLines !== undefined &&
    (typeof contextLines !== "number" ||
      !Number.isInteger(contextLines) ||
      contextLines < 0 ||
      contextLines > 12)
  ) {
    throw new ContractValidationError("contextLines must be an integer from 0 to 12.");
  }
  const rawPaths = value.paths;
  if (
    rawPaths !== undefined &&
    (!Array.isArray(rawPaths) ||
      rawPaths.length > 32 ||
      rawPaths.some((candidate) => typeof candidate !== "string"))
  ) {
    throw new ContractValidationError("paths must contain at most 32 strings.");
  }
  const paths = Array.isArray(rawPaths)
    ? rawPaths.map((candidate) => normalizeRepositoryRelativePath(candidate as string))
    : undefined;
  return {
    ...(contextLines === undefined ? {} : { contextLines: contextLines as number }),
    ...(paths === undefined ? {} : { paths }),
  };
}

function parseLogInput(value: unknown): GitLogInput {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value) || Object.keys(value).some((key) => key !== "limit")) {
    throw new ContractValidationError("Invalid git.log input.");
  }
  const limit = value.limit;
  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)
  ) {
    throw new ContractValidationError("limit must be an integer from 1 to 50.");
  }
  return limit === undefined ? {} : { limit: limit as number };
}

function failure(
  commandId: string,
  commandName: ReadonlyGitCommandName,
  startedAt: number,
  code: CommandErrorCode,
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

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  for (const name of ["SystemRoot", "WINDIR", "PATHEXT", "TEMP", "TMP"] as const) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function classifyError(error: unknown): {
  code: CommandErrorCode;
  message: string;
  retryable: boolean;
} {
  if (error instanceof ReadonlyGitBridgeError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof ContractValidationError) {
    return { code: "INVALID_COMMAND", message: error.message, retryable: false };
  }
  if (error instanceof WorkspacePathError) {
    return { code: "WORKSPACE_INVALID", message: error.message, retryable: false };
  }
  if (hasErrorCode(error, "ENOENT")) {
    return { code: "GIT_UNAVAILABLE", message: "Git executable is unavailable.", retryable: false };
  }
  if (isTimedOut(error)) {
    return { code: "TIMEOUT", message: "Read-only Git command timed out.", retryable: true };
  }
  if (isOutputLimitError(error)) {
    return {
      code: "OUTPUT_LIMIT_EXCEEDED",
      message: "Read-only Git output exceeded the configured stream limit.",
      retryable: false,
    };
  }
  const message = error instanceof Error ? error.message.slice(0, 300) : "Git command failed.";
  return { code: "GIT_FAILED", message, retryable: false };
}

class ReadonlyGitBridgeError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReadonlyGitBridgeError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function isPlainCommandName(
  value: unknown,
): value is { command: { name: ReadonlyGitCommandName } } {
  return (
    isPlainObject(value) &&
    isPlainObject(value.command) &&
    isReadonlyGitCommandName(String(value.command.name))
  );
}

function isReadonlyGitCommandName(value: string): value is ReadonlyGitCommandName {
  return value === "git.status" || value === "git.diff" || value === "git.log";
}

function isTimedOut(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { killed?: boolean }).killed === true
  );
}

function isOutputLimitError(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    hasErrorCode(error, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}
