import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runGit } from "./execution-plane";

async function makeRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "conductor-worktree-http-"));
  await runGit(root, ["init", "--initial-branch", "main"]);
  await runGit(root, ["config", "user.email", "tests@conductor.local"]);
  await runGit(root, ["config", "user.name", "Conductor HTTP Tests"]);
  await writeFile(path.join(root, "README.md"), "http test\n", "utf8");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-m", "initial"]);
  return root;
}

async function jsonRequest(baseUrl: string, pathname: string, body: unknown, token?: string) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Conductor-Approval": token } : {}),
    },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() as Record<string, unknown> };
}

test("worktree lifecycle HTTP routes require payload-bound approval", async () => {
  const root = await makeRepository();
  const previous = {
    port: process.env.CONDUCTOR_COMPANION_PORT,
    host: process.env.CONDUCTOR_COMPANION_HOST,
    workspace: process.env.CONDUCTOR_WORKSPACE_ROOT,
    origins: process.env.CONDUCTOR_ALLOWED_ORIGINS,
  };
  process.env.CONDUCTOR_COMPANION_PORT = "0";
  process.env.CONDUCTOR_COMPANION_HOST = "127.0.0.1";
  process.env.CONDUCTOR_WORKSPACE_ROOT = root;
  process.env.CONDUCTOR_ALLOWED_ORIGINS = "http://localhost:3000";
  const { startCompanionServer } = await import("./local-git-server.ts");
  const server = startCompanionServer();
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const missing = await jsonRequest(baseUrl, "/worktrees/prepare", { taskId: "http-task" });
    assert.equal(missing.response.status, 400);
    assert.match(JSON.stringify(missing.payload), /approval/i);

    const prepareApproval = await jsonRequest(baseUrl, "/approvals/request", {
      action: "worktree.prepare",
      input: { taskId: "http-task" },
    });
    assert.equal(prepareApproval.response.status, 200);
    const approvedPrepare = await jsonRequest(baseUrl, "/approvals/approve", {
      confirm: true,
      approvalId: prepareApproval.payload.approvalId,
      digest: prepareApproval.payload.digest,
    });
    assert.equal(approvedPrepare.response.status, 200);
    const prepared = await jsonRequest(baseUrl, "/worktrees/prepare", { taskId: "http-task" }, String(approvedPrepare.payload.token));
    assert.equal(prepared.response.status, 200);
    assert.equal((prepared.payload.worktree as Record<string, unknown>).taskId, "http-task");

    const invalidRelease = await jsonRequest(baseUrl, "/worktrees/release", { taskId: "http-task", force: true }, "invalid-token");
    assert.equal(invalidRelease.response.status, 400);
    assert.match(JSON.stringify(invalidRelease.payload), /approval/i);

    const releaseApproval = await jsonRequest(baseUrl, "/approvals/request", {
      action: "worktree.release",
      input: { taskId: "http-task", force: true },
    });
    const approvedRelease = await jsonRequest(baseUrl, "/approvals/approve", {
      confirm: true,
      approvalId: releaseApproval.payload.approvalId,
      digest: releaseApproval.payload.digest,
    });
    const released = await jsonRequest(baseUrl, "/worktrees/release", { taskId: "http-task", force: true }, String(approvedRelease.payload.token));
    assert.equal(released.response.status, 200);
    assert.equal((released.payload.worktree as Record<string, unknown>).status, "released");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
    if (previous.port === undefined) delete process.env.CONDUCTOR_COMPANION_PORT; else process.env.CONDUCTOR_COMPANION_PORT = previous.port;
    if (previous.host === undefined) delete process.env.CONDUCTOR_COMPANION_HOST; else process.env.CONDUCTOR_COMPANION_HOST = previous.host;
    if (previous.workspace === undefined) delete process.env.CONDUCTOR_WORKSPACE_ROOT; else process.env.CONDUCTOR_WORKSPACE_ROOT = previous.workspace;
    if (previous.origins === undefined) delete process.env.CONDUCTOR_ALLOWED_ORIGINS; else process.env.CONDUCTOR_ALLOWED_ORIGINS = previous.origins;
  }
});
