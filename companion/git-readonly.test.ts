import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { WorkspacePathError, normalizeRepositoryRelativePath } from "./workspace-path";
import {
  buildReadOnlyGitArguments,
  executeReadOnlyGitCommand,
  MAX_GIT_STREAM_BYTES,
  parseReadOnlyGitCommand,
  type ReadonlyGitCommand,
} from "./git-readonly";

const execFileAsync = promisify(execFile);

function envelope(capability: string, name: string, input: unknown): unknown {
  const issuedAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  return {
    schemaVersion: "companion.command.v1",
    kind: "companion.command",
    commandId: "test-command-1",
    issuedAt,
    expiresAt,
    policyVersion: "test-policy-1",
    workspace: { root: process.cwd() },
    capability,
    command: { name, input },
  };
}

test("capabilities are matched to exactly one read command", async () => {
  const result = await executeReadOnlyGitCommand(
    envelope("git.read.status", "git.diff", {}),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "CAPABILITY_MISMATCH");

  assert.throws(
    () => parseReadOnlyGitCommand("git.read.log", "git.commit", {}),
    /do not match/,
  );
});

test("repository pathspecs reject traversal and absolute paths", () => {
  assert.throws(
    () => normalizeRepositoryRelativePath("../outside"),
    WorkspacePathError,
  );
  assert.throws(
    () => normalizeRepositoryRelativePath("C:\\outside"),
    WorkspacePathError,
  );
  assert.equal(normalizeRepositoryRelativePath("src\\safe.ts"), "src/safe.ts");
});

test("the executable bridge can construct only status, diff, and log verbs", () => {
  const commands: readonly ReadonlyGitCommand[] = [
    { name: "git.status", input: {} },
    { name: "git.diff", input: { paths: ["--output=outside"] } },
    { name: "git.log", input: { limit: 3 } },
  ];
  const allowed = new Set(["status", "diff", "log"]);
  for (const command of commands) {
    const argumentsList = buildReadOnlyGitArguments(command);
    const verb = argumentsList.find((argument) => allowed.has(argument));
    assert.ok(verb);
    assert.ok(allowed.has(verb));
    assert.equal(argumentsList.includes("commit"), false);
    assert.equal(argumentsList.includes("push"), false);
    assert.equal(argumentsList.includes("reset"), false);
  }

  const diffArguments = buildReadOnlyGitArguments(commands[1]);
  assert.ok(diffArguments.indexOf("--") < diffArguments.indexOf("--output=outside"));
});

test("process output has a finite per-stream ceiling", () => {
  assert.ok(Number.isSafeInteger(MAX_GIT_STREAM_BYTES));
  assert.ok(MAX_GIT_STREAM_BYTES > 0 && MAX_GIT_STREAM_BYTES <= 256_000);
});

test("oversized Git output fails closed instead of returning a partial success", async () => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "companion-readonly-"));
  try {
    await execFileAsync("git", ["init", "--quiet"], { cwd: repository });
    await execFileAsync("git", ["config", "user.name", "Companion Test"], {
      cwd: repository,
    });
    await execFileAsync("git", ["config", "user.email", "companion@example.invalid"], {
      cwd: repository,
    });
    const fixture = path.join(repository, "large.txt");
    await writeFile(fixture, "before\n".repeat(40_000), "utf8");
    await execFileAsync("git", ["add", "large.txt"], { cwd: repository });
    await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: repository,
    });
    await writeFile(fixture, "after\n".repeat(40_000), "utf8");

    const result = await executeReadOnlyGitCommand(
      {
        ...(envelope("git.read.diff", "git.diff", {}) as Record<string, unknown>),
        workspace: { root: repository },
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.code,
        "OUTPUT_LIMIT_EXCEEDED",
        JSON.stringify(result.error),
      );
    }
  } finally {
    await rm(repository, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
