import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type WorkspacePathErrorCode =
  | "INVALID_PATH"
  | "PATH_NOT_FOUND"
  | "PATH_OUTSIDE_WORKSPACE"
  | "NOT_A_DIRECTORY";

export class WorkspacePathError extends Error {
  constructor(
    readonly code: WorkspacePathErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export interface CanonicalWorkspacePath {
  readonly canonicalRoot: string;
  readonly canonicalPath: string;
  readonly repositoryRelativePath: string;
}

export async function canonicalizeWorkspaceRoot(root: string): Promise<string> {
  assertUsablePath(root, "workspace root");
  if (!path.isAbsolute(root)) {
    throw new WorkspacePathError(
      "INVALID_PATH",
      "Workspace root must be an absolute path.",
    );
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    throw new WorkspacePathError("PATH_NOT_FOUND", "Workspace root was not found.");
  }

  const rootStat = await stat(canonicalRoot);
  if (!rootStat.isDirectory()) {
    throw new WorkspacePathError(
      "NOT_A_DIRECTORY",
      "Workspace root is not a directory.",
    );
  }
  return canonicalRoot;
}

export async function resolveCanonicalWorkspacePath(
  workspaceRoot: string,
  requestedPath = ".",
): Promise<CanonicalWorkspacePath> {
  const canonicalRoot = await canonicalizeWorkspaceRoot(workspaceRoot);
  assertUsablePath(requestedPath, "requested path");

  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(canonicalRoot, requestedPath);
  assertContained(canonicalRoot, candidate);

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidate);
  } catch {
    throw new WorkspacePathError("PATH_NOT_FOUND", "Requested path was not found.");
  }
  assertContained(canonicalRoot, canonicalPath);

  return {
    canonicalRoot,
    canonicalPath,
    repositoryRelativePath: toPosix(path.relative(canonicalRoot, canonicalPath)) || ".",
  };
}

export async function assertWorkspaceStillCanonical(
  canonicalRoot: string,
): Promise<void> {
  const observed = await canonicalizeWorkspaceRoot(canonicalRoot);
  if (!samePath(canonicalRoot, observed)) {
    throw new WorkspacePathError(
      "PATH_OUTSIDE_WORKSPACE",
      "Workspace identity changed during execution.",
    );
  }
}

export async function assertGitMarker(canonicalRoot: string): Promise<void> {
  try {
    const marker = await lstat(path.join(canonicalRoot, ".git"));
    if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
      throw new WorkspacePathError("INVALID_PATH", "Unsafe .git marker type.");
    }
  } catch (error) {
    if (error instanceof WorkspacePathError) {
      throw error;
    }
    throw new WorkspacePathError(
      "PATH_NOT_FOUND",
      "Workspace root does not contain a .git marker.",
    );
  }
}

export function normalizeRepositoryRelativePath(input: string): string {
  assertUsablePath(input, "repository-relative path");
  if (path.isAbsolute(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) {
    throw new WorkspacePathError("INVALID_PATH", "Pathspec must be repository-relative.");
  }

  const segments = input.replaceAll("\\", "/").split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new WorkspacePathError(
        "PATH_OUTSIDE_WORKSPACE",
        "Pathspec may not traverse above the repository root.",
      );
    }
    normalized.push(segment);
  }
  if (normalized.length === 0) {
    throw new WorkspacePathError("INVALID_PATH", "Empty pathspecs are not allowed.");
  }
  return normalized.join("/");
}

export function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new WorkspacePathError(
      "PATH_OUTSIDE_WORKSPACE",
      "Path resolves outside the canonical workspace root.",
    );
  }
}

function assertUsablePath(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0")
  ) {
    throw new WorkspacePathError("INVALID_PATH", `Invalid ${name}.`);
  }
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
