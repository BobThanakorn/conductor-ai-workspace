import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "orchestrator/cli.mjs");
const roadmap = resolve(root, "orchestrator/roadmap.json");

async function context() {
  const directory = await mkdtemp(join(tmpdir(), "conductor-orchestrator-"));
  return { directory, state: join(directory, "state.json") };
}

function run(ctx, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CONDUCTOR_ORCHESTRATOR_ROADMAP: roadmap, CONDUCTOR_ORCHESTRATOR_STATE: ctx.state }
  });
  const stream = result.status === 0 ? result.stdout : result.stderr;
  return { ...result, json: JSON.parse(stream) };
}

test("validates roadmap, dependencies and worker profiles", async () => {
  const ctx = await context();
  const result = run(ctx, "validate");
  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.workers, ["codex", "terra", "luna"]);
  assert.ok(result.json.tasks >= 10);
});

test("reports initial roadmap without creating tracked state", async () => {
  const ctx = await context();
  const result = run(ctx, "status");
  assert.equal(result.status, 0);
  assert.equal(result.json.counts.pending, result.json.phases.flatMap((phase) => phase.tasks).length);
  assert.equal(result.json.next.terra, "P1-T1");
  assert.equal(result.json.next.luna, "P1-T0");
});

test("returns a bounded handoff for the next eligible worker task", async () => {
  const ctx = await context();
  const result = run(ctx, "next", "--worker", "terra");
  assert.equal(result.status, 0);
  assert.equal(result.json.task.taskId, "P1-T1");
  assert.ok(result.json.task.operatingRules.some((rule) => rule.includes("Do not commit")));
});

test("claim records an expiring lease and enforces worker capacity", async () => {
  const ctx = await context();
  const claimed = run(ctx, "claim", "P1-T1", "--worker", "terra", "--lease-minutes", "5");
  assert.equal(claimed.status, 0);
  assert.equal(claimed.json.handoff.taskId, "P1-T1");
  assert.ok(Date.parse(claimed.json.handoff.leaseExpiresAt) > Date.now());
  const second = run(ctx, "claim", "P1-T1", "--worker", "terra");
  assert.equal(second.status, 1);
  assert.match(second.json.error, /concurrency limit/);
});

test("blocked dependency cannot be claimed", async () => {
  const ctx = await context();
  const result = run(ctx, "claim", "P1-T2", "--worker", "terra");
  assert.equal(result.status, 1);
  assert.match(result.json.error, /blocked by: P1-T1/);
});

test("heartbeat extends the active lease", async () => {
  const ctx = await context();
  const claimed = run(ctx, "claim", "P1-T1", "--worker", "terra", "--lease-minutes", "1");
  const renewed = run(ctx, "heartbeat", "P1-T1", "--worker", "terra", "--lease-minutes", "10");
  assert.equal(renewed.status, 0);
  assert.ok(Date.parse(renewed.json.leaseExpiresAt) > Date.parse(claimed.json.handoff.leaseExpiresAt));
});

test("submission rejects missing required verification", async () => {
  const ctx = await context();
  run(ctx, "claim", "P1-T1", "--worker", "terra");
  const evidence = join(ctx.directory, "bad-evidence.json");
  await writeFile(evidence, JSON.stringify({ summary: "partial", files: [], checks: [] }));
  const result = run(ctx, "submit", "P1-T1", "--worker", "terra", "--evidence", evidence);
  assert.equal(result.status, 1);
  assert.match(result.json.error, /Missing required check evidence/);
});

test("valid evidence enters review and prevents self-approval", async () => {
  const ctx = await context();
  run(ctx, "claim", "P1-T1", "--worker", "terra");
  const evidence = join(ctx.directory, "evidence.json");
  await writeFile(evidence, JSON.stringify({
    summary: "Contract implemented",
    files: [{ path: "lib/contract.ts", change: "added" }],
    checks: [
      { command: "npm run typecheck", exitCode: 0 },
      { command: "npm test", exitCode: 0 }
    ]
  }));
  const submitted = run(ctx, "submit", "P1-T1", "--worker", "terra", "--evidence", evidence);
  assert.equal(submitted.status, 0);
  assert.equal(submitted.json.status, "needs_review");
  const selfReview = run(ctx, "review", "P1-T1", "--reviewer", "terra", "--decision", "approve");
  assert.equal(selfReview.status, 1);
  assert.match(selfReview.json.error, /cannot approve their own task/);
  const approved = run(ctx, "review", "P1-T1", "--reviewer", "luna", "--decision", "approve");
  assert.equal(approved.status, 0);
  assert.equal(approved.json.status, "completed");
});

test("approved dependency unlocks the next task", async () => {
  const ctx = await context();
  const state = {
    version: 1,
    updatedAt: new Date().toISOString(),
    tasks: {
      "P1-T1": { status: "completed", attempts: 1, claimedBy: "terra", leaseExpiresAt: null, evidence: {}, review: { reviewer: "luna", decision: "approve" }, lastError: null }
    }
  };
  await writeFile(ctx.state, JSON.stringify(state));
  const result = run(ctx, "next", "--worker", "terra");
  assert.equal(result.status, 0);
  assert.equal(result.json.task.taskId, "P1-T2");
  const persisted = JSON.parse(await readFile(ctx.state, "utf8"));
  assert.equal(persisted.tasks["P1-T1"].status, "completed");
});
