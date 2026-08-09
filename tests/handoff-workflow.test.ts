import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertEvidenceUnchanged,
  assertIndependentReviewer,
  buildHandoffEnvelope,
  evidenceDigest,
  handoffActionSchema,
  handoffContextSchema,
  isAllowedTransition,
} from "../lib/handoff-workflow.ts";
import { authenticateHandoffIdentity, createHandoffIdentityToken } from "../lib/handoff-identity.ts";

const context = {
  snapshotId: "sha-test",
  files: [{ path: "src/index.ts", content: "export const ok = true;", snapshotId: "sha-test" }],
  totalTokens: 6,
};
const evidence = { summary: "Checks passed", files: [{ path: "src/index.ts", change: "added" }], checks: [{ command: "npm test", exitCode: 0, stdout: "ok" }] };

test("role transitions are explicit and sequential", () => {
  assert.equal(isAllowedTransition("planner", "implementer"), true);
  assert.equal(isAllowedTransition("implementer", "tester"), true);
  assert.equal(isAllowedTransition("tester", "reviewer"), true);
  assert.equal(isAllowedTransition("reviewer", "planner"), false);
  assert.throws(() => handoffActionSchema.parse({
    action: "create", workspaceId: "workspace_local", taskId: "task_1", fromRole: "reviewer", toRole: "planner",
    context, evidence,
  }));
  assert.throws(() => handoffActionSchema.parse({
    action: "create", workspaceId: "workspace_local", taskId: "task_1", fromRole: "planner", toRole: "implementer",
    submittedBy: "attacker", context, evidence,
  }));
  assert.throws(() => handoffActionSchema.parse({
    action: "accept", workspaceId: "workspace_local", handoffId: "handoff_1", role: "reviewer", actor: "attacker",
  }));
});

test("handoff context is bounded, snapshot-bound, and rejects secrets/traversal", () => {
  assert.doesNotThrow(() => handoffContextSchema.parse(context));
  assert.throws(() => handoffContextSchema.parse({ ...context, files: [{ ...context.files[0], path: "../.env" }] }));
  assert.throws(() => handoffContextSchema.parse({ ...context, files: [{ ...context.files[0], snapshotId: "stale" }] }));
  assert.throws(() => handoffContextSchema.parse({ ...context, totalTokens: 999 }));
  assert.throws(() => handoffContextSchema.parse({
    ...context,
    files: [{ ...context.files[0], path: "docs/example.txt", content: "api_key=github_pat_examplecredential123456789" }],
    totalTokens: 13,
  }));
});

test("evidence digest is immutable and reviewers cannot self-approve", async () => {
  const envelope = await buildHandoffEnvelope({
    id: "handoff_test_1", workspaceId: "workspace_local", taskId: "task_1",
    fromRole: "tester", toRole: "reviewer", submittedBy: "terra", context, evidence,
  });
  assert.equal(envelope.evidenceDigest, await evidenceDigest(evidence));
  await assertEvidenceUnchanged(envelope, evidence);
  await assert.rejects(() => assertEvidenceUnchanged(envelope, { ...evidence, summary: "tampered" }));
  assert.throws(() => assertIndependentReviewer("terra", "terra"));
  assert.throws(() => assertIndependentReviewer("Terra", "terra"));
  assert.doesNotThrow(() => assertIndependentReviewer("terra", "luna"));
});

test("handoff identity is signed, role-bound input is rejected, and tampering fails closed", async () => {
  const secret = "test-handoff-signing-secret";
  const token = await createHandoffIdentityToken({ actorId: "Worker:Terra", role: "implementer", kind: "worker", workspaceId: "workspace_local", taskId: "task_1", secret });
  const principal = await authenticateHandoffIdentity(
    new Request("http://localhost/api/handoffs", { headers: { authorization: `Bearer ${token}` } }),
    secret,
    { workspaceId: "workspace_local", taskId: "task_1" },
  );
  assert.deepEqual(principal, {
    actorId: "worker:terra", role: "implementer", kind: "worker", audience: "conductor-handoff-api",
    workspaceId: "workspace_local", taskId: "task_1", expiresAt: principal.expiresAt,
  });
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  await assert.rejects(() => authenticateHandoffIdentity(new Request("http://localhost/api/handoffs", { headers: { "x-conductor-identity": tampered } }), secret));
  await assert.rejects(() => authenticateHandoffIdentity(new Request("http://localhost/api/handoffs", { headers: { "x-conductor-identity": token } }), "wrong-secret"));
  await assert.rejects(() => authenticateHandoffIdentity(new Request("http://localhost/api/handoffs"), secret));
  await assert.rejects(() => authenticateHandoffIdentity(new Request("http://localhost/api/handoffs", { headers: { "x-conductor-identity": token } }), secret, { workspaceId: "other_workspace" }));
  await assert.rejects(() => authenticateHandoffIdentity(new Request("http://localhost/api/handoffs", { headers: { "x-conductor-identity": token } }), secret, { workspaceId: "workspace_local", taskId: "other_task" }));
  await assert.rejects(() => createHandoffIdentityToken({ actorId: " ", role: "reviewer", kind: "worker", workspaceId: "workspace_local", secret }));
});

test("handoff endpoint and durable append-only review storage are wired", async () => {
  const [route, store, schema] = await Promise.all([
    readFile(new URL("../app/api/handoffs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/handoff-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/environment-store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /handoffActionSchema/);
  assert.match(route, /claimIdempotency/);
  assert.match(route, /publishHandoff/);
  assert.match(route, /authenticateHandoffIdentity/);
  assert.match(route, /CONDUCTOR_HANDOFF_SIGNING_SECRET/);
  assert.match(route, /detailLevel === "full"/);
  assert.doesNotMatch(route, /input\.submittedBy/);
  assert.match(store, /handoff_evidence_conflict/);
  assert.match(store, /assertIndependentReviewer/);
  assert.match(store, /recorded_only_human_must_merge_or_push/);
  assert.match(store, /published_by/);
  assert.match(store, /human publication authorization recorded/i);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS handoffs/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS handoff_reviews/);
  assert.match(schema, /handoff_reviews_no_update/);
  assert.match(schema, /handoffs_immutable_payload/);
  assert.match(schema, /handoffs_no_delete/);
});
