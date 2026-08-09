import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { runGit } from "./execution-plane";
import { normalizeRepositoryRelativePath } from "./workspace-path";

const STATE_VERSION = 1;
// Keep task ids safe as both Git branch suffixes and Windows/POSIX path
// segments.  Colons are deliberately excluded because they are invalid in a
// Windows directory name.
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type WorktreeStatus = "active" | "released" | "orphaned";
export type WorktreeRecord = {
  taskId: string;
  repositoryRoot: string;
  path: string;
  branch: string;
  baseSha: string;
  status: WorktreeStatus;
  createdAt: string;
  releasedAt?: string;
  orphanedAt?: string;
  evidencePath?: string;
  seededFiles?: string[];
};

type WorktreeState = { version: number; records: WorktreeRecord[] };

// Worktree creation is a filesystem + Git + shared-state transaction. Serialize
// preparation for one repository so concurrent tasks cannot race while reading
// and atomically replacing the lifecycle state file.
const repositoryLocks = new Map<string, Promise<void>>();
const MAX_SEED_FILE_BYTES = 4_000_000;
const MAX_SEED_TOTAL_BYTES = 64_000_000;

async function withRepositoryLock<T>(repositoryRoot: string, operation: () => Promise<T>) {
  const previous = repositoryLocks.get(repositoryRoot) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  repositoryLocks.set(repositoryRoot, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (repositoryLocks.get(repositoryRoot) === tail) repositoryLocks.delete(repositoryRoot);
  }
}

function assertTaskId(taskId: string) {
  if (!TASK_ID.test(taskId)) throw new Error("taskId is invalid for worktree isolation.");
}

function assertInside(root: string, candidate: string) {
  const base = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("Worktree path must remain inside the selected repository.");
  }
  return resolved;
}

async function assertNoSymlinkAncestors(root: string, candidateDirectory: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidateDirectory);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Worktree path must remain inside the selected repository.");
  }
  const rootMetadata = await lstat(resolvedRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Selected repository root must be a real directory.");
  }
  let current = resolvedRoot;
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error("Worktree metadata cannot contain symbolic-link directories.");
      if (!metadata.isDirectory()) break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

function statePath(root: string) {
  return path.join(path.resolve(root), ".conductor", "worktrees.json");
}

async function loadState(root: string): Promise<WorktreeState> {
  await assertNoSymlinkAncestors(root, path.dirname(statePath(root)));
  try {
    const parsed = JSON.parse(await readFile(statePath(root), "utf8")) as Partial<WorktreeState>;
    return {
      version: parsed.version === STATE_VERSION ? STATE_VERSION : STATE_VERSION,
      records: Array.isArray(parsed.records) ? parsed.records.filter((item): item is WorktreeRecord => Boolean(item && typeof item === "object" && typeof item.taskId === "string" && typeof item.path === "string" && typeof item.branch === "string")) : [],
    };
  } catch {
    return { version: STATE_VERSION, records: [] };
  }
}

async function saveState(root: string, state: WorktreeState) {
  const directory = path.dirname(statePath(root));
  await assertNoSymlinkAncestors(root, directory);
  await mkdir(directory, { recursive: true });
  await assertNoSymlinkAncestors(root, directory);
  const temporary = `${statePath(root)}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: STATE_VERSION, records: state.records }, null, 2)}\n`, "utf8");
  await rename(temporary, statePath(root));
}

async function preserveWorktreeEvidence(repositoryRoot: string, record: WorktreeRecord) {
  const captureId = `${record.taskId}-${Date.now().toString(36)}`;
  const evidencePath = assertInside(repositoryRoot, path.join(repositoryRoot, ".conductor", "evidence", captureId));
  await assertNoSymlinkAncestors(repositoryRoot, path.dirname(evidencePath));
  await mkdir(evidencePath, { recursive: true });
  await assertNoSymlinkAncestors(repositoryRoot, evidencePath);
  const [status, diff, untracked] = await Promise.all([
    runGit(record.path, ["status", "--porcelain", "--untracked-files=all"]),
    runGit(record.path, ["diff", "HEAD", "--binary"]),
    runGit(record.path, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  await writeFile(path.join(evidencePath, "metadata.json"), `${JSON.stringify({
    taskId: record.taskId,
    branch: record.branch,
    baseSha: record.baseSha,
    capturedAt: new Date().toISOString(),
    status: status.stdout,
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(evidencePath, "working.patch"), diff.stdout, "utf8");
  const untrackedRoot = path.join(evidencePath, "untracked");
  for (const listedPath of untracked.stdout.split("\0").filter(Boolean)) {
    const relative = normalizeRepositoryRelativePath(listedPath);
    const source = path.resolve(record.path, relative);
    const target = assertInside(evidencePath, path.join(untrackedRoot, relative));
    assertInside(record.path, source);
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4_000_000) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return evidencePath;
}

function isSensitiveSeedPath(relativePath: string) {
  const fileName = relativePath.toLowerCase().split("/").at(-1) ?? "";
  return fileName === ".env" || fileName.startsWith(".env.") || fileName.startsWith("secret.") ||
    [".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".der", ".jks"].some((suffix) => fileName.endsWith(suffix));
}

function isGeneratedSeedPath(relativePath: string) {
  const segments = relativePath.toLowerCase().split("/");
  const fileName = segments.at(-1) ?? "";
  return segments.some((segment) => [".git", ".conductor", "node_modules", "dist", ".next", ".vinext", ".wrangler", "__pycache__", "test-results", "coverage"].includes(segment)) ||
    fileName.endsWith(".pyc") || fileName.endsWith(".tsbuildinfo") || fileName.endsWith(".tar.gz");
}

async function changedWorkspacePaths(root: string) {
  const [unstaged, staged, untracked] = await Promise.all([
    runGit(root, ["diff", "--name-only", "--no-renames", "--"]),
    runGit(root, ["diff", "--cached", "--name-only", "--no-renames", "--"]),
    runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const paths = new Set<string>();
  for (const value of `${unstaged.stdout}\n${staged.stdout}`.split(/\r?\n/)) {
    if (value.trim()) paths.add(normalizeRepositoryRelativePath(value.trim()));
  }
  for (const value of untracked.stdout.split("\0")) {
    if (value) paths.add(normalizeRepositoryRelativePath(value));
  }
  return [...paths];
}

async function seedWorkingTree(repositoryRoot: string, worktreePath: string, overwriteExisting = true) {
  const paths = await changedWorkspacePaths(repositoryRoot);
  const seededFiles: string[] = [];
  let totalBytes = 0;
  for (const relative of paths) {
    if (isSensitiveSeedPath(relative) || isGeneratedSeedPath(relative)) continue;
    const source = assertInside(repositoryRoot, path.join(repositoryRoot, relative));
    const target = assertInside(worktreePath, path.join(worktreePath, relative));
    try {
      await assertNoSymlinkAncestors(repositoryRoot, path.dirname(source));
      await assertNoSymlinkAncestors(worktreePath, path.dirname(target));
      if (!overwriteExisting && await lstat(target).then(() => true).catch(() => false)) continue;
      const metadata = await lstat(source);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      if (metadata.size > MAX_SEED_FILE_BYTES || (totalBytes += metadata.size) > MAX_SEED_TOTAL_BYTES) {
        throw new Error("The workspace changes exceed the bounded task seed limit.");
      }
      await mkdir(path.dirname(target), { recursive: true });
      await assertNoSymlinkAncestors(worktreePath, path.dirname(target));
      await copyFile(source, target);
      seededFiles.push(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (overwriteExisting) await rm(target, { force: true });
        continue;
      }
      throw error;
    }
  }
  return seededFiles;
}

function branchFor(root: string, taskId: string) {
  const digest = createHash("sha256").update(`${path.resolve(root)}:${taskId}`).digest("hex").slice(0, 12);
  const suffix = taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "task";
  return `agent/task-${suffix}-${digest}`;
}

async function gitRefExists(root: string, branch: string) {
  try {
    await runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function isWorktreeDirectory(directory: string, repositoryRoot?: string) {
  try {
    const metadata = await stat(directory);
    if (!metadata.isDirectory()) return false;
    const result = await runGit(directory, ["rev-parse", "--show-toplevel"]);
    const [actualDirectory, reportedDirectory] = await Promise.all([
      realpath(directory),
      realpath(result.stdout.trim()),
    ]);
    const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
    if (repositoryRoot) {
      const canonicalRoot = normalize(await realpath(repositoryRoot));
      const canonicalWorktree = normalize(actualDirectory);
      if (canonicalWorktree === canonicalRoot || !canonicalWorktree.startsWith(`${canonicalRoot}${path.sep}`)) return false;
    }
    return normalize(actualDirectory) === normalize(reportedDirectory);
  } catch {
    return false;
  }
}

export async function prepareTaskWorktree(root: string, taskId: string, baseRef = "HEAD") {
  assertTaskId(taskId);
  const repositoryRoot = path.resolve(root);
  return withRepositoryLock(repositoryRoot, () => prepareTaskWorktreeLocked(repositoryRoot, taskId, baseRef));
}

async function prepareTaskWorktreeLocked(repositoryRoot: string, taskId: string, baseRef: string) {
  const state = await loadState(repositoryRoot);
  const existing = state.records.find((record) => record.taskId === taskId && record.repositoryRoot === repositoryRoot);
  if (existing?.status === "active" && await isWorktreeDirectory(existing.path, repositoryRoot)) {
    // Retries must not overwrite task-local edits, but they may need to bring
    // newly-created files from the selected workspace into an older active
    // worktree (for example after a process restart).
    const seededFiles = await seedWorkingTree(repositoryRoot, existing.path, false);
    if (!seededFiles.length) return existing;
    const updated: WorktreeRecord = {
      ...existing,
      seededFiles: [...new Set([...(existing.seededFiles ?? []), ...seededFiles])],
    };
    state.records = state.records.map((item) => item === existing ? updated : item);
    await saveState(repositoryRoot, state);
    return updated;
  }

  const worktreePath = assertInside(repositoryRoot, path.join(repositoryRoot, ".conductor", "worktrees", taskId));
  if (await stat(worktreePath).then(() => true).catch(() => false)) {
    throw new Error("A worktree path collision was detected; refusing to reuse an untracked directory.");
  }
  const branch = existing?.branch ?? branchFor(repositoryRoot, taskId);
  const branchExists = await gitRefExists(repositoryRoot, branch);
  const baseSha = (await runGit(repositoryRoot, ["rev-parse", baseRef])).stdout.trim();
  await assertNoSymlinkAncestors(repositoryRoot, path.dirname(worktreePath));
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await assertNoSymlinkAncestors(repositoryRoot, path.dirname(worktreePath));
  // A previous process may have removed the checkout but not yet pruned its
  // administrative entry.  Pruning stale entries is safe and allows a task
  // with preserved evidence to resume at the same path and branch.
  await runGit(repositoryRoot, ["worktree", "prune"], 120_000).catch(() => undefined);
  if (branchExists) {
    await runGit(repositoryRoot, ["worktree", "add", "--", worktreePath, branch], 120_000);
  } else {
    await runGit(repositoryRoot, ["worktree", "add", "-b", branch, "--", worktreePath, baseRef], 120_000);
  }
  const seededFiles = await seedWorkingTree(repositoryRoot, worktreePath);
  const record: WorktreeRecord = {
    taskId,
    repositoryRoot,
    path: worktreePath,
    branch,
    baseSha,
    status: "active",
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    ...(seededFiles.length ? { seededFiles } : {}),
  };
  state.records = [...state.records.filter((item) => !(item.taskId === taskId && item.repositoryRoot === repositoryRoot)), record];
  await saveState(repositoryRoot, state);
  return record;
}

export async function resolveTaskWorktree(root: string, taskId: string) {
  assertTaskId(taskId);
  const repositoryRoot = path.resolve(root);
  const state = await loadState(repositoryRoot);
  const record = state.records.find((item) => item.taskId === taskId && item.repositoryRoot === repositoryRoot && item.status === "active");
  if (!record) throw new Error("The task has no active isolated worktree; prepare it before mutation.");
  assertInside(repositoryRoot, record.path);
  if (!await isWorktreeDirectory(record.path, repositoryRoot)) throw new Error("The task worktree is missing or outside the repository; recover or prepare it before mutation.");
  return record;
}

async function releaseTaskWorktreeLocked(root: string, taskId: string, force = false) {
  assertTaskId(taskId);
  const repositoryRoot = path.resolve(root);
  const state = await loadState(repositoryRoot);
  const record = state.records.find((item) => item.taskId === taskId && item.repositoryRoot === repositoryRoot);
  if (!record) throw new Error("No worktree exists for this task.");
  assertInside(repositoryRoot, record.path);
  let evidencePath: string | undefined;
  if (await isWorktreeDirectory(record.path, repositoryRoot)) {
    const status = await runGit(record.path, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.stdout.trim() && !force) {
      throw new Error("The task worktree has uncommitted changes; review or release with force=true to preserve evidence before cleanup.");
    }
    if (status.stdout.trim() && force) evidencePath = await preserveWorktreeEvidence(repositoryRoot, record);
    await runGit(repositoryRoot, ["worktree", "remove", ...(force ? ["--force"] : []), "--", record.path], 120_000);
    await runGit(repositoryRoot, ["worktree", "prune"], 120_000).catch(() => undefined);
  } else {
    await rm(record.path, { recursive: true, force: true });
  }
  const released: WorktreeRecord = { ...record, status: "released", releasedAt: new Date().toISOString(), ...(evidencePath ? { evidencePath } : {}) };
  state.records = state.records.map((item) => item === record ? released : item);
  await saveState(repositoryRoot, state);
  return released;
}

export async function releaseTaskWorktree(root: string, taskId: string, force = false) {
  return withRepositoryLock(path.resolve(root), () => releaseTaskWorktreeLocked(root, taskId, force));
}

async function recoverTaskWorktreesLocked(root: string) {
  const repositoryRoot = path.resolve(root);
  const state = await loadState(repositoryRoot);
  let changed = false;
  const records = await Promise.all(state.records.map(async (record) => {
    if (record.repositoryRoot !== repositoryRoot || record.status !== "active") return record;
    assertInside(repositoryRoot, record.path);
    if (await isWorktreeDirectory(record.path, repositoryRoot)) return record;
    changed = true;
    return { ...record, status: "orphaned" as const, orphanedAt: new Date().toISOString() };
  }));
  if (changed) await saveState(repositoryRoot, { ...state, records });
  await runGit(repositoryRoot, ["worktree", "prune"], 120_000).catch(() => undefined);
  return records;
}

export async function recoverTaskWorktrees(root: string) {
  return withRepositoryLock(path.resolve(root), () => recoverTaskWorktreesLocked(root));
}

export async function listTaskWorktrees(root: string) {
  const records = await recoverTaskWorktrees(root);
  return records.filter((record) => record.repositoryRoot === path.resolve(root));
}
