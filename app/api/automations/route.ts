import process from "node:process";
import { z } from "zod";
import { ApiError, errorResponse, jsonResponse, readJsonBody, validationError } from "@/lib/api-contract";
import { parseAutomationProfileDefinition, parseAutomationTrigger, nextScheduledRun } from "@/lib/automation-contract";
import { authenticateServerPrincipal } from "@/lib/server-principal";
import { ensureEnvironmentDatabase, getDatabase } from "@/lib/environment-store";
import { ensureOperationsSchema, quotaLimit, reserveQuota, traceId } from "@/lib/operations";

export const dynamic = "force-dynamic";
const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const bodySchema = z.object({ action: z.enum(["profile", "automation", "run", "cancel", "replay", "pause", "resume"]), workspaceId: id, profileId: id.optional(), automationId: id.optional(), runId: id.optional(), kind: z.enum(["agent", "skill"]).optional(), name: z.string().trim().min(1).max(120).optional(), definition: z.unknown().optional(), trigger: z.unknown().optional(), agentProfileId: id.optional(), agentProfileVersion: z.number().int().positive().optional(), skillProfileId: id.optional(), skillProfileVersion: z.number().int().positive().optional(), command: id.optional(), idempotencyKey: id.optional() }).strict();

async function actor(request: Request, workspaceId: string) { return authenticateServerPrincipal(request, process.env.CONDUCTOR_HANDOFF_SIGNING_SECRET, { workspaceId }); }
function now() { return new Date().toISOString(); }
async function event(database: D1Database, runId: string, workspaceId: string, actorId: string, type: string, detail: Record<string, unknown>, eventId = crypto.randomUUID()) {
  await database.prepare("INSERT OR IGNORE INTO automation_events (event_id, run_id, workspace_id, type, actor_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(eventId, runId, workspaceId, type, actorId, JSON.stringify(detail), now()).run();
}

export async function materializeAutomationRun(
  database: D1Database,
  automation: Record<string, unknown>,
  ownerId: string,
  key: string,
  options: { expectedScheduleSlot?: string } = {},
) {
  const workspaceId = String(automation.workspace_id); const automationId = String(automation.id);
  const workspace = await database.prepare("SELECT base_sha, head_sha FROM workspaces WHERE id = ?").bind(workspaceId).first<{ base_sha: string; head_sha: string }>();
  if (!workspace) throw new ApiError(404, "workspace_not_found", "Automation workspace was not found.");
  const agent = await database.prepare("SELECT definition_json FROM automation_profiles WHERE workspace_id = ? AND owner_id = ? AND kind = 'agent' AND id = ? AND version = ?").bind(workspaceId, ownerId, automation.agent_profile_id, automation.agent_profile_version).first<{ definition_json: string }>();
  const skill = await database.prepare("SELECT definition_json FROM automation_profiles WHERE workspace_id = ? AND owner_id = ? AND kind = 'skill' AND id = ? AND version = ?").bind(workspaceId, ownerId, automation.skill_profile_id, automation.skill_profile_version).first<{ definition_json: string }>();
  if (!agent || !skill) throw new ApiError(409, "automation_profile_version_missing", "Pinned immutable automation profiles are unavailable.");
  const agentDefinition = parseAutomationProfileDefinition("agent", JSON.parse(agent.definition_json));
  const skillDefinition = parseAutomationProfileDefinition("skill", JSON.parse(skill.definition_json));
  let runId = crypto.randomUUID(); let taskId = `auto_${crypto.randomUUID().replaceAll("-", "")}`; let snapshotId = crypto.randomUUID(); let created = now();
  const leaseOwner = `materializer:${crypto.randomUUID()}`;
  const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const reservation = options.expectedScheduleSlot
    ? database.prepare(
        `INSERT OR IGNORE INTO automation_runs
          (id, automation_id, workspace_id, owner_id, idempotency_key, status, snapshot_id, task_id,
           lease_owner, lease_expires_at, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, 'materializing', ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM automations
           WHERE id = ? AND workspace_id = ? AND owner_id = ? AND enabled = 1 AND next_run_at = ?
         )`,
      ).bind(
        runId, automationId, workspaceId, ownerId, key, snapshotId, taskId,
        leaseOwner, leaseExpiresAt, created, created,
        automationId, workspaceId, ownerId, options.expectedScheduleSlot,
      )
    : database.prepare(
        "INSERT OR IGNORE INTO automation_runs (id, automation_id, workspace_id, owner_id, idempotency_key, status, snapshot_id, task_id, lease_owner, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'materializing', ?, ?, ?, ?, ?, ?)",
      ).bind(runId, automationId, workspaceId, ownerId, key, snapshotId, taskId, leaseOwner, leaseExpiresAt, created, created);
  const reserved = await reservation.run();
  if ((reserved.meta.changes ?? 0) !== 1) {
    const existing = await database.prepare("SELECT id, task_id, snapshot_id, status, lease_expires_at, created_at FROM automation_runs WHERE automation_id = ? AND idempotency_key = ?").bind(automationId, key).first<{ id: string; task_id: string | null; snapshot_id: string; status: string; lease_expires_at: string | null; created_at: string }>();
    if (!existing) {
      if (options.expectedScheduleSlot) throw new ApiError(409, "automation_schedule_no_longer_due", "The scheduled slot is no longer enabled or due.");
      throw new ApiError(409, "automation_run_conflict", "Automation run reservation conflicted.");
    }
    if (existing.status !== "materializing") return { runId: existing.id, taskId: existing.task_id, status: existing.status, replayed: true };
    if (existing.lease_expires_at && Date.parse(existing.lease_expires_at) > Date.now()) return { runId: existing.id, taskId: existing.task_id, status: existing.status, replayed: true };
    const reclaimed = await database.prepare("UPDATE automation_runs SET lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'materializing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").bind(leaseOwner, leaseExpiresAt, now(), existing.id, now()).run();
    if ((reclaimed.meta.changes ?? 0) !== 1) return { runId: existing.id, taskId: existing.task_id, status: "materializing", replayed: true };
    runId = existing.id; taskId = existing.task_id ?? taskId; snapshotId = existing.snapshot_id; created = existing.created_at;
  }
  await database.batch([
    database.prepare("INSERT OR IGNORE INTO automation_snapshots (id, run_id, workspace_id, manifest_json, created_at) VALUES (?, ?, ?, ?, ?)").bind(snapshotId, runId, workspaceId, JSON.stringify({ schemaVersion: 1, workspace: { id: workspaceId, baseSha: workspace.base_sha, headSha: workspace.head_sha }, profiles: { agent: { id: automation.agent_profile_id, version: automation.agent_profile_version, definition: agentDefinition }, skill: { id: automation.skill_profile_id, version: automation.skill_profile_version, definition: skillDefinition } }, capturedAt: created }), created),
    database.prepare("INSERT OR IGNORE INTO tasks (id, workspace_id, title, goal, status, risk_level, branch, base_sha, actor, progress, created_by_idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, 'planning', 'R1', ?, ?, ?, 0, ?, ?, ?)").bind(taskId, workspaceId, `Automation: ${automation.name}`, `${"systemPrompt" in agentDefinition ? agentDefinition.systemPrompt : ""}\n\nEnabled skills: ${"skills" in skillDefinition ? skillDefinition.skills.join(", ") || "none" : "none"}.\nThis run may create a proposal only. Human approval is required before file mutation, execution, commit, push, merge, or publication. Pinned agent profile: ${automation.agent_profile_id}@${automation.agent_profile_version}; skill profile: ${automation.skill_profile_id}@${automation.skill_profile_version}; snapshot: ${snapshotId}.`, `automation/${runId.slice(0, 12)}`, workspace.head_sha, `automation:${automationId}`, `automation:${runId}`, created, created),
  ]);
  await event(database, runId, workspaceId, ownerId, "automation.run.materialized", { taskId, snapshot: { id: snapshotId, baseSha: workspace.base_sha, headSha: workspace.head_sha, capturedAt: created }, profiles: { agent: `${automation.agent_profile_id}@${automation.agent_profile_version}`, skill: `${automation.skill_profile_id}@${automation.skill_profile_version}` }, approvalRequired: true }, `automation-run:${runId}:materialized`);
  const finalized = await database.prepare("UPDATE automation_runs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'materializing' AND lease_owner = ?").bind(now(), runId, leaseOwner).run();
  if ((finalized.meta.changes ?? 0) !== 1) throw new ApiError(409, "automation_run_lease_lost", "Automation run materialization lost its lease before completion.");
  return { runId, taskId, status: "queued", replayed: false };
}

export async function GET(request: Request) {
  try { const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "workspace_local"; const principal = await actor(request, workspaceId); const database = getDatabase(); await ensureEnvironmentDatabase(database);
    const [profiles, automations, runs, events, snapshots] = await database.batch([
      database.prepare("SELECT id, kind, version, name, definition_json, created_at FROM automation_profiles WHERE workspace_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 100").bind(workspaceId, principal.actorId),
      database.prepare("SELECT * FROM automations WHERE workspace_id = ? AND owner_id = ? ORDER BY updated_at DESC LIMIT 100").bind(workspaceId, principal.actorId),
      database.prepare("SELECT * FROM automation_runs WHERE workspace_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 100").bind(workspaceId, principal.actorId),
      database.prepare("SELECT e.* FROM automation_events e JOIN automation_runs r ON r.id = e.run_id WHERE e.workspace_id = ? AND r.owner_id = ? ORDER BY e.sequence DESC LIMIT 200").bind(workspaceId, principal.actorId),
      database.prepare("SELECT s.id, s.run_id, s.manifest_json, s.created_at FROM automation_snapshots s JOIN automation_runs r ON r.id = s.run_id WHERE s.workspace_id = ? AND r.owner_id = ? ORDER BY s.created_at DESC LIMIT 100").bind(workspaceId, principal.actorId),
    ]); return jsonResponse({ ok: true, workspaceId, profiles: profiles.results, automations: automations.results, runs: runs.results, events: events.results, snapshots: snapshots.results });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  const operationTraceId = traceId(request);
  const withTrace = (response: Response) => {
    response.headers.set("x-conductor-trace-id", operationTraceId);
    return response;
  };
  try { const parsed = bodySchema.safeParse(await readJsonBody(request)); if (!parsed.success) throw validationError(parsed.error); const input = parsed.data; const principal = await actor(request, input.workspaceId); const database = getDatabase(); await ensureEnvironmentDatabase(database); await ensureOperationsSchema(database); await reserveQuota(database, { workspaceId: input.workspaceId, actorId: principal.actorId, traceId: operationTraceId, bucket: "automation", limit: quotaLimit(process.env.CONDUCTOR_AUTOMATION_QUOTA_PER_MINUTE, 30) });
    if (input.action === "profile") { if (!input.profileId || !input.kind || !input.name || input.definition === undefined) throw new ApiError(400, "profile_invalid", "profileId, kind, name and definition are required."); const definition = parseAutomationProfileDefinition(input.kind, input.definition); const previous = await database.prepare("SELECT MAX(version) AS version FROM automation_profiles WHERE workspace_id = ? AND owner_id = ? AND kind = ? AND id = ?").bind(input.workspaceId, principal.actorId, input.kind, input.profileId).first<{ version: number | null }>(); const version = (previous?.version ?? 0) + 1; await database.prepare("INSERT INTO automation_profiles (id, workspace_id, owner_id, kind, version, name, definition_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(input.profileId, input.workspaceId, principal.actorId, input.kind, version, input.name, JSON.stringify(definition), now()).run(); return withTrace(jsonResponse({ ok: true, profileId: input.profileId, version }, 201)); }
    if (input.action === "automation") { if (!input.automationId || !input.name || !input.agentProfileId || !input.agentProfileVersion || !input.skillProfileId || !input.skillProfileVersion) throw new ApiError(400, "automation_invalid", "Automation profiles and name are required."); const [agentProfile, skillProfile] = await database.batch([database.prepare("SELECT 1 AS present FROM automation_profiles WHERE workspace_id = ? AND owner_id = ? AND kind = 'agent' AND id = ? AND version = ?").bind(input.workspaceId, principal.actorId, input.agentProfileId, input.agentProfileVersion), database.prepare("SELECT 1 AS present FROM automation_profiles WHERE workspace_id = ? AND owner_id = ? AND kind = 'skill' AND id = ? AND version = ?").bind(input.workspaceId, principal.actorId, input.skillProfileId, input.skillProfileVersion)]); if (!agentProfile.results.length || !skillProfile.results.length) throw new ApiError(409, "automation_profile_version_missing", "The selected immutable profile versions are unavailable for this owner and workspace."); const trigger = parseAutomationTrigger(input.trigger); const timestamp = now(); await database.prepare("INSERT INTO automations (id, workspace_id, owner_id, name, enabled, trigger_json, agent_profile_id, agent_profile_version, skill_profile_id, skill_profile_version, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)").bind(input.automationId, input.workspaceId, principal.actorId, input.name, JSON.stringify(trigger), input.agentProfileId, input.agentProfileVersion, input.skillProfileId, input.skillProfileVersion, nextScheduledRun(trigger), timestamp, timestamp).run(); return withTrace(jsonResponse({ ok: true, automationId: input.automationId }, 201)); }
    const automation = input.automationId ? await database.prepare("SELECT * FROM automations WHERE id = ? AND workspace_id = ? AND owner_id = ?").bind(input.automationId, input.workspaceId, principal.actorId).first<Record<string, unknown>>() : null;
    if (!automation && input.action !== "cancel" && input.action !== "replay") throw new ApiError(404, "automation_not_found", "Automation was not found for this owner and workspace.");
    if (input.action === "pause" || input.action === "resume") { await database.prepare("UPDATE automations SET enabled = ?, updated_at = ? WHERE id = ? AND owner_id = ?").bind(input.action === "resume" ? 1 : 0, now(), automation!.id, principal.actorId).run(); return withTrace(jsonResponse({ ok: true, enabled: input.action === "resume" })); }
    if (input.action === "run") { if (Number(automation!.enabled) !== 1) throw new ApiError(409, "automation_paused", "A paused automation cannot create a new run."); const trigger = parseAutomationTrigger(JSON.parse(String(automation!.trigger_json))); if (trigger.type !== "manual" && !(trigger.type === "command" && input.command === trigger.command)) throw new ApiError(409, "automation_trigger_not_manual", "This automation requires its configured trigger."); return withTrace(jsonResponse({ ok: true, ...(await materializeAutomationRun(database, automation!, principal.actorId, input.idempotencyKey ?? `manual:${crypto.randomUUID()}`)) }, 201)); }
    if (input.action === "cancel") {
      if (!input.runId) throw new ApiError(400, "run_id_required", "runId is required.");
      const run = await database.prepare("SELECT * FROM automation_runs WHERE id = ? AND workspace_id = ? AND owner_id = ?").bind(input.runId, input.workspaceId, principal.actorId).first<Record<string, unknown>>();
      if (!run) throw new ApiError(404, "automation_run_not_found", "Run was not found.");
      if (run.status === "completed") throw new ApiError(409, "automation_run_completed", "A completed automation run cannot be cancelled.");
      if (run.status === "cancelled") return withTrace(jsonResponse({ ok: true, cancelled: true, replayed: true }));
      const cancelledAt = now();
      const eventId = `automation-run:${input.runId}:cancelled`;
      const results = await database.batch([
        database.prepare(
          "UPDATE automation_runs SET cancel_requested = 1, status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ? AND owner_id = ? AND status NOT IN ('completed', 'cancelled')",
        ).bind(cancelledAt, input.runId, input.workspaceId, principal.actorId),
        database.prepare(
          `UPDATE approvals SET status = 'withdrawn', decided_by = 'system', decided_at = ?, decision_note = 'Automation run cancelled'
           WHERE task_id = ? AND status = 'pending'
             AND EXISTS (SELECT 1 FROM automation_runs WHERE id = ? AND status = 'cancelled' AND updated_at = ?)`,
        ).bind(cancelledAt, run.task_id, input.runId, cancelledAt),
        database.prepare(
          `UPDATE tasks SET status = 'cancelled', cancellation_reason = 'Automation run cancelled',
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ? AND status NOT IN ('completed', 'cancelled')
             AND EXISTS (SELECT 1 FROM automation_runs WHERE id = ? AND status = 'cancelled' AND updated_at = ?)`,
        ).bind(cancelledAt, run.task_id, input.runId, cancelledAt),
        database.prepare(
          `INSERT OR IGNORE INTO automation_events
            (event_id, run_id, workspace_id, type, actor_id, detail_json, created_at)
           SELECT ?, id, workspace_id, 'automation.run.cancel_requested', ?, ?, ?
           FROM automation_runs WHERE id = ? AND status = 'cancelled' AND updated_at = ?`,
        ).bind(eventId, principal.actorId, JSON.stringify({ taskId: run.task_id }), cancelledAt, input.runId, cancelledAt),
      ]);
      if ((results[0].meta.changes ?? 0) !== 1) {
        const current = await database.prepare("SELECT status FROM automation_runs WHERE id = ? AND workspace_id = ? AND owner_id = ?").bind(input.runId, input.workspaceId, principal.actorId).first<{ status: string }>();
        if (current?.status === "completed") throw new ApiError(409, "automation_run_completed", "The run completed before cancellation could be committed.");
        if (current?.status === "cancelled") return withTrace(jsonResponse({ ok: true, cancelled: true, replayed: true }));
        throw new ApiError(409, "automation_run_cancel_conflict", "The automation run changed before cancellation could be committed.");
      }
      return withTrace(jsonResponse({ ok: true, cancelled: true, replayed: false }));
    }
    if (input.action === "replay") {
      if (!input.runId) throw new ApiError(400, "run_id_required", "runId is required.");
      const original = await database.prepare("SELECT automation_id FROM automation_runs WHERE id = ? AND workspace_id = ? AND owner_id = ?").bind(input.runId, input.workspaceId, principal.actorId).first<{ automation_id: string }>();
      if (!original) throw new ApiError(404, "automation_run_not_found", "Run was not found.");
      const originalAutomation = await database.prepare("SELECT * FROM automations WHERE id = ? AND workspace_id = ? AND owner_id = ?").bind(original.automation_id, input.workspaceId, principal.actorId).first<Record<string, unknown>>();
      if (!originalAutomation) throw new ApiError(409, "automation_replay_unavailable", "The original automation is no longer available.");
      if (Number(originalAutomation.enabled) !== 1) throw new ApiError(409, "automation_paused", "A paused automation cannot be replayed.");
      return withTrace(jsonResponse({ ok: true, ...(await materializeAutomationRun(database, originalAutomation, principal.actorId, `replay:${input.runId}:${crypto.randomUUID()}`)) }, 201));
    }
    throw new ApiError(400, "automation_action_invalid", "Unsupported automation action.");
  } catch (error) { return withTrace(errorResponse(error)); }
}
