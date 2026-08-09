import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runGit } from "./execution-plane";
import {
  listTaskWorktrees,
  prepareTaskWorktree,
  releaseTaskWorktree,
  resolveTaskWorktree,
} from "./worktree-manager";

async function makeRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-worktree-"));
  await runGit(root, ["init", "--initial-branch", "main"]);
  await runGit(root, ["config", "user.email", "tests@conductor.local"]);
  await runGit(root, ["config", "user.name", "Conductor Tests"]);
  await writeFile(path.join(root, "README.md"), "initial\n", "utf8");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-m", "initial"]);
  return root;
}

async function cleanupRepository(root: string) {
  await runGit(root, ["worktree", "prune"]).catch(() => undefined);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test("task worktrees are isolated, bounded, and idempotent", async () => {
  const root = await makeRepository();
  try {
    await writeFile(path.join(root, "README.md"), "working tree edit\n", "utf8");
    await writeFile(path.join(root, "untracked.txt"), "untracked input\n", "utf8");
    const [first, second] = await Promise.all([
      prepareTaskWorktree(root, "task-alpha"),
      prepareTaskWorktree(root, "task-beta"),
    ]);
    assert.notEqual(first.path, second.path);
    assert.notEqual(first.branch, second.branch);
    assert.ok(first.path.startsWith(`${path.resolve(root)}${path.sep}`));
    assert.ok(second.path.startsWith(`${path.resolve(root)}${path.sep}`));
    assert.deepEqual(first.seededFiles?.sort(), ["README.md", "untracked.txt"]);
    assert.equal(await readFile(path.join(first.path, "README.md"), "utf8"), "working tree edit\n");
    assert.equal(await readFile(path.join(first.path, "untracked.txt"), "utf8"), "untracked input\n");
    assert.equal((await resolveTaskWorktree(root, "task-alpha")).path, first.path);

    const [retryA, retryB] = await Promise.all([
      prepareTaskWorktree(root, "task-alpha"),
      prepareTaskWorktree(root, "task-alpha"),
    ]);
    assert.equal(retryA.path, first.path);
    assert.equal(retryB.branch, first.branch);

    const records = await listTaskWorktrees(root);
    assert.deepEqual(records.map((record) => record.taskId).sort(), ["task-alpha", "task-beta"]);
    await releaseTaskWorktree(root, "task-alpha", true);
    await releaseTaskWorktree(root, "task-beta", true);
  } finally {
    await cleanupRepository(root);
  }
});

test("release preserves the branch and evidence record, then can be resumed", async () => {
  const root = await makeRepository();
  try {
    const active = await prepareTaskWorktree(root, "task-resume");
    await writeFile(path.join(active.path, "evidence.txt"), "kept on branch\n", "utf8");
    await assert.rejects(() => releaseTaskWorktree(root, "task-resume"), /uncommitted changes/i);
    const released = await releaseTaskWorktree(root, "task-resume", true);
    assert.equal(released.status, "released");
    assert.ok(released.evidencePath);
    assert.match(await readFile(path.join(released.evidencePath!, "untracked", "evidence.txt"), "utf8"), /kept on branch/);
    await runGit(root, ["show-ref", "--verify", `refs/heads/${active.branch}`]);
    await assert.rejects(() => resolveTaskWorktree(root, "task-resume"), /no active isolated worktree/i);

    const resumed = await prepareTaskWorktree(root, "task-resume");
    assert.equal(resumed.branch, active.branch);
    assert.equal(resumed.status, "active");
    assert.equal((await resolveTaskWorktree(root, "task-resume")).path, resumed.path);
  } finally {
    await cleanupRepository(root);
  }
});

test("invalid task ids and path collisions fail closed", async () => {
  const root = await makeRepository();
  try {
    await assert.rejects(() => prepareTaskWorktree(root, "../escape"), /invalid/i);
    await assert.rejects(() => prepareTaskWorktree(root, "task/escape"), /invalid/i);
    const collisionPath = path.join(root, ".conductor", "worktrees", "task-collision");
    await mkdir(path.dirname(collisionPath), { recursive: true });
    await writeFile(collisionPath, "not a worktree\n", "utf8");
    await assert.rejects(() => prepareTaskWorktree(root, "task-collision"), /collision/i);
  } finally {
    await cleanupRepository(root);
  }
});

test("symlinked worktree metadata ancestors fail closed", async (context) => {
  const root = await makeRepository();
  const outside = await mkdtemp(path.join(os.tmpdir(), "conductor-worktree-outside-"));
  try {
    try {
      await symlink(outside, path.join(root, ".conductor"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") {
        context.skip("directory junction creation is unavailable on this host");
        return;
      }
      throw error;
    }
    await assert.rejects(() => prepareTaskWorktree(root, "task-symlink"), /symbolic|symlink/i);
  } finally {
    await cleanupRepository(root);
    await rm(outside, { recursive: true, force: true });
  }
});
