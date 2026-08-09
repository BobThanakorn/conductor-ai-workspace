import { ApiError } from "@/lib/api-contract";
import {
  assertEvidenceUnchanged,
  assertIndependentReviewer,
  buildHandoffEnvelope,
  evidenceDigest,
  handoffEnvelopeSchema,
  type HandoffRole,
  type HandoffAction,
  type HandoffEnvelope,
  type HandoffEvidence,
} from "@/lib/handoff-workflow";

type CreateHandoffInput = Extract<HandoffAction, { action: "create" }> & { submittedBy: string };
type ScopedHandoffIdentity = { taskScope?: string };
type AcceptHandoffInput = Extract<HandoffAction, { action: "accept" }> & ScopedHandoffIdentity & { role: HandoffRole; actor: string };
type ReviewHandoffInput = Extract<HandoffAction, { action: "review" }> & ScopedHandoffIdentity & { reviewerId: string };
type ResolveHandoffInput = Extract<HandoffAction, { action: "resolve" }> & ScopedHandoffIdentity & { actor: string; humanApproved: true };
type PublishHandoffInput = Extract<HandoffAction, { action: "publish" }> & ScopedHandoffIdentity & { actor: string; humanApproved: true };

type HandoffRow = {
  id: string;
  workspace_id: string;
  task_id: string;
  from_role: HandoffEnvelope["fromRole"];
  to_role: HandoffEnvelope["toRole"];
  submitted_by: string;
  status: HandoffEnvelope["status"];
  context_json: string;
  evidence_json: string;
  evidence_digest: string;
  created_at: string;
  accepted_by: string | null;
  accepted_at: string | null;
  published_by: string | null;
  published_at: string | null;
  updated_at: string;
  version: number;
};

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function mapHandoff(row: HandoffRow) {
  return handoffEnvelopeSchema.parse({
    version: 1,
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    fromRole: row.from_role,
    toRole: row.to_role,
    submittedBy: row.submitted_by,
    context: parseJson(row.context_json, { snapshotId: "unknown", files: [], totalTokens: 0 }),
    evidence: parseJson(row.evidence_json, { summary: "Unavailable", files: [], checks: [] }),
    evidenceDigest: row.evidence_digest,
    status: row.status,
    createdAt: row.created_at,
  });
}

function summarizeHandoff(handoff: HandoffEnvelope) {
  return {
    id: handoff.id,
    workspaceId: handoff.workspaceId,
    taskId: handoff.taskId,
    fromRole: handoff.fromRole,
    toRole: handoff.toRole,
    evidenceDigest: handoff.evidenceDigest,
    status: handoff.status,
    createdAt: handoff.createdAt,
  };
}

function changed(result: unknown): number {
  return Number((result as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
}

function reviewId(handoffId: string): string {
  // Idempotency is enforced at the API request boundary; review rows remain
  // append-only and therefore need a fresh identity for each new decision or
  // human resolution after a conflict.
  return `handoff_review_${handoffId}_${crypto.randomUUID()}`.slice(0, 190);
}

function assertHumanActor(actor: string): void {
  if (!/^human[:/@]/i.test(actor.trim())) {
    throw new ApiError(403, "human_approval_required", "This action requires an authenticated human actor.");
  }
}

export async function listHandoffs(
  database: D1Database,
  workspaceId: string,
  taskId?: string,
  options: { includeDetails?: boolean } = {},
) {
  const workspace = await database.prepare("SELECT id FROM workspaces WHERE id = ? LIMIT 1").bind(workspaceId).first();
  if (!workspace) throw new ApiError(404, "workspace_not_found", "Workspace not found.");
  const query = taskId
    ? database.prepare("SELECT * FROM handoffs WHERE workspace_id = ? AND task_id = ? ORDER BY created_at ASC LIMIT 100").bind(workspaceId, taskId)
    : database.prepare("SELECT * FROM handoffs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100").bind(workspaceId);
  const result = await query.all<HandoffRow>();
  const handoffs = await Promise.all(result.results.map(async (row) => {
    const handoff = mapHandoff(row);
    await verifyStoredEvidence(handoff, handoff.evidence);
    return handoff;
  }));
  return {
    handoffs: options.includeDetails ? handoffs : handoffs.map(summarizeHandoff),
    detailLevel: options.includeDetails ? "full" as const : "summary" as const,
    generatedAt: new Date().toISOString(),
  };
}

export async function createHandoff(database: D1Database, input: CreateHandoffInput): Promise<HandoffEnvelope> {
  const task = await database.prepare(
    `SELECT tasks.id, tasks.base_sha, workspaces.head_sha
     FROM tasks JOIN workspaces ON workspaces.id = tasks.workspace_id
     WHERE tasks.id = ? AND tasks.workspace_id = ? LIMIT 1`,
  ).bind(input.taskId, input.workspaceId).first<{ id: string; base_sha: string; head_sha: string }>();
  if (!task) throw new ApiError(404, "task_not_found", "Task was not found in this workspace.");
  if (input.fromRole !== "planner") {
    const prerequisite = await database.prepare(
      `SELECT id, context_json FROM handoffs
       WHERE workspace_id = ? AND task_id = ? AND to_role = ?
         AND status IN ('accepted', 'approved', 'published')
       ORDER BY created_at DESC LIMIT 1`,
    ).bind(input.workspaceId, input.taskId, input.fromRole).first<{ id: string; context_json: string }>();
    if (!prerequisite) throw new ApiError(409, "handoff_prerequisite_missing", `No accepted handoff exists for the ${input.fromRole} role.`);
    const prerequisiteContext = parseJson<{ snapshotId?: string }>(prerequisite.context_json, {});
    if (!prerequisiteContext.snapshotId || prerequisiteContext.snapshotId !== input.context.snapshotId) {
      throw new ApiError(409, "handoff_snapshot_conflict", "The handoff snapshot does not match the accepted prerequisite.");
    }
  } else {
    const validSnapshots = new Set([task.base_sha, task.head_sha].map((value) => value?.trim()).filter(Boolean));
    if (!validSnapshots.has(input.context.snapshotId)) {
      throw new ApiError(409, "handoff_snapshot_stale", "The handoff snapshot does not match the task or workspace repository state.");
    }
  }
  const id = `handoff_${crypto.randomUUID()}`;
  const envelope = await buildHandoffEnvelope({ ...input, id });
  const createdAt = envelope.createdAt;
  const result = await database.prepare(
    `INSERT INTO handoffs
      (id, workspace_id, task_id, from_role, to_role, submitted_by, status,
       context_json, evidence_json, evidence_digest, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).bind(
    envelope.id, envelope.workspaceId, envelope.taskId, envelope.fromRole,
    envelope.toRole, envelope.submittedBy, JSON.stringify(envelope.context),
    JSON.stringify(envelope.evidence), envelope.evidenceDigest, createdAt, createdAt,
  ).run();
  if (changed(result) !== 1) throw new ApiError(409, "handoff_create_conflict", "The handoff could not be persisted.");
  return envelope;
}

async function getHandoff(database: D1Database, workspaceId: string, handoffId: string): Promise<HandoffEnvelope & { acceptedBy: string | null; acceptedAt: string | null }> {
  const row = await database.prepare("SELECT * FROM handoffs WHERE id = ? AND workspace_id = ? LIMIT 1").bind(handoffId, workspaceId).first<HandoffRow>();
  if (!row) throw new ApiError(404, "handoff_not_found", "Handoff was not found in this workspace.");
  const handoff = mapHandoff(row);
  await verifyStoredEvidence(handoff, handoff.evidence);
  return { ...handoff, acceptedBy: row.accepted_by, acceptedAt: row.accepted_at };
}

function assertTaskScope(taskId: string, taskScope?: string): void {
  if (taskScope && taskScope !== taskId) {
    throw new ApiError(403, "handoff_identity_scope_forbidden", "The signed handoff identity does not cover this task.");
  }
}

export async function acceptHandoff(database: D1Database, input: AcceptHandoffInput) {
  const current = await getHandoff(database, input.workspaceId, input.handoffId);
  assertTaskScope(current.taskId, input.taskScope);
  if (current.toRole !== input.role) throw new ApiError(403, "handoff_role_forbidden", "Only the designated receiving role can accept this handoff.");
  if (current.status !== "pending") throw new ApiError(409, "handoff_state_conflict", "Only a pending handoff can be accepted.");
  const acceptedAt = new Date().toISOString();
  const result = await database.prepare(
    `UPDATE handoffs SET status = 'accepted', accepted_by = ?, accepted_at = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
  ).bind(input.actor, acceptedAt, acceptedAt, input.handoffId, input.workspaceId).run();
  if (changed(result) !== 1) throw new ApiError(409, "handoff_state_conflict", "The handoff changed before it could be accepted.");
  return { ...current, status: "accepted" as const, acceptedBy: input.actor, acceptedAt };
}

export async function reviewHandoff(database: D1Database, input: ReviewHandoffInput) {
  const current = await getHandoff(database, input.workspaceId, input.handoffId);
  assertTaskScope(current.taskId, input.taskScope);
  if (current.toRole !== "reviewer") throw new ApiError(409, "handoff_not_reviewable", "Only tester-to-reviewer handoffs can be reviewed.");
  if (current.status !== "accepted") throw new ApiError(409, "handoff_state_conflict", "The receiving reviewer must accept this handoff before review.");
  try {
    assertIndependentReviewer(current.submittedBy, input.reviewerId);
  } catch (error) {
    throw new ApiError(403, "independent_review_required", error instanceof Error ? error.message : "The submitting worker cannot review its own handoff.");
  }
  const reviewAt = new Date().toISOString();
  const reviewIdValue = reviewId(current.id);
  if (input.evidenceDigest !== current.evidenceDigest) {
    await database.batch([
      database.prepare("UPDATE handoffs SET status = 'conflict', updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ? AND status IN ('accepted', 'pending')").bind(reviewAt, current.id, input.workspaceId),
      database.prepare("INSERT OR IGNORE INTO handoff_reviews (id, workspace_id, handoff_id, reviewer_id, decision, notes, evidence_digest, human_approved, created_at) VALUES (?, ?, ?, ?, 'conflict', ?, ?, 0, ?)").bind(reviewIdValue, input.workspaceId, current.id, input.reviewerId, "Evidence digest mismatch; human resolution required.", input.evidenceDigest, reviewAt),
    ]);
    throw new ApiError(409, "handoff_evidence_conflict", "The submitted evidence does not match the immutable handoff digest.");
  }
  const nextStatus = input.decision === "approve" ? "approved" : "rejected";
  if (input.decision === "reject" && !input.notes?.trim()) throw new ApiError(400, "review_notes_required", "Rejected handoffs require review notes.");
  const result = await database.batch([
    database.prepare("UPDATE handoffs SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ? AND status IN ('accepted', 'pending')").bind(nextStatus, reviewAt, current.id, input.workspaceId),
    database.prepare("INSERT INTO handoff_reviews (id, workspace_id, handoff_id, reviewer_id, decision, notes, evidence_digest, human_approved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)").bind(reviewIdValue, input.workspaceId, current.id, input.reviewerId, input.decision, input.notes ?? "", input.evidenceDigest, reviewAt),
  ]);
  if (changed(result[0]) !== 1) throw new ApiError(409, "handoff_state_conflict", "The handoff changed before the review was recorded.");
  return { ...current, status: nextStatus as "approved" | "rejected" };
}

export async function resolveHandoff(database: D1Database, input: ResolveHandoffInput) {
  assertHumanActor(input.actor);
  const current = await getHandoff(database, input.workspaceId, input.handoffId);
  assertTaskScope(current.taskId, input.taskScope);
  if (current.status !== "conflict") throw new ApiError(409, "handoff_not_conflicted", "Only a conflicted handoff can be resolved.");
  const nextStatus = input.resolution === "retry" ? "pending" : "rejected";
  const resolvedAt = new Date().toISOString();
  const result = await database.batch([
    database.prepare("UPDATE handoffs SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ? AND status = 'conflict'").bind(nextStatus, resolvedAt, current.id, input.workspaceId),
    database.prepare("INSERT INTO handoff_reviews (id, workspace_id, handoff_id, reviewer_id, decision, notes, evidence_digest, human_approved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)").bind(reviewIdValueForResolution(current.id), input.workspaceId, current.id, input.actor, input.resolution, "Human resolution recorded.", current.evidenceDigest, resolvedAt),
  ]);
  if (changed(result[0]) !== 1) throw new ApiError(409, "handoff_state_conflict", "The conflicted handoff changed before resolution.");
  return { ...current, status: nextStatus as "pending" | "rejected" };
}

function reviewIdValueForResolution(handoffId: string): string {
  return reviewId(handoffId);
}

export async function publishHandoff(database: D1Database, input: PublishHandoffInput) {
  assertHumanActor(input.actor);
  const current = await getHandoff(database, input.workspaceId, input.handoffId);
  assertTaskScope(current.taskId, input.taskScope);
  if (current.status !== "approved") throw new ApiError(409, "handoff_not_publishable", "Only an independently approved handoff can be published.");
  const publishedAt = new Date().toISOString();
  const result = await database.batch([
    database.prepare("UPDATE handoffs SET status = 'published', published_by = ?, published_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ? AND status = 'approved'").bind(input.actor, publishedAt, publishedAt, current.id, input.workspaceId),
    database.prepare("INSERT INTO handoff_reviews (id, workspace_id, handoff_id, reviewer_id, decision, notes, evidence_digest, human_approved, created_at) VALUES (?, ?, ?, ?, 'publish', ?, ?, 1, ?)").bind(reviewId(current.id), input.workspaceId, current.id, input.actor, "Human publication authorization recorded; Git merge and push remain separate approval-gated actions.", current.evidenceDigest, publishedAt),
  ]);
  if (changed(result[0]) !== 1) throw new ApiError(409, "handoff_state_conflict", "The approved handoff changed before publication was recorded.");
  return { ...current, status: "published" as const, publishedBy: input.actor, publishedAt, publication: "recorded_only_human_must_merge_or_push" };
}

export async function verifyStoredEvidence(envelope: HandoffEnvelope, evidence: HandoffEvidence): Promise<void> {
  await assertEvidenceUnchanged(envelope, evidence);
  const digest = await evidenceDigest(evidence);
  if (digest !== envelope.evidenceDigest) throw new ApiError(409, "handoff_evidence_conflict", "Stored evidence digest verification failed.");
}
