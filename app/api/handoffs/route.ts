import process from "node:process";
import {
  ApiError,
  errorResponse,
  jsonResponse,
  readJsonBody,
  requireIdempotencyKey,
  validationError,
} from "@/lib/api-contract";
import {
  claimIdempotency,
  completeIdempotency,
  digest,
  ensureEnvironmentDatabase,
  getDatabase,
  getEnvironmentBindings,
  storeIdempotentError,
} from "@/lib/environment-store";
import {
  acceptHandoff,
  createHandoff,
  listHandoffs,
  publishHandoff,
  resolveHandoff,
  reviewHandoff,
} from "@/lib/handoff-store";
import { handoffActionSchema } from "@/lib/handoff-workflow";
import { authenticateHandoffIdentity } from "@/lib/handoff-identity";

export const dynamic = "force-dynamic";

function workspaceIdFrom(request: Request): string {
  const value = new URL(request.url).searchParams.get("workspaceId")?.trim() || "workspace_local";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new ApiError(400, "invalid_workspace_id", "workspaceId is not valid.");
  return value;
}

function taskIdFrom(request: Request): string | undefined {
  const value = new URL(request.url).searchParams.get("taskId")?.trim();
  if (!value) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new ApiError(400, "invalid_task_id", "taskId is not valid.");
  return value;
}

function handoffSigningSecret(): string | undefined {
  const bindingSecret = getEnvironmentBindings().CONDUCTOR_HANDOFF_SIGNING_SECRET?.trim();
  if (bindingSecret) return bindingSecret;
  return process.env.CONDUCTOR_HANDOFF_SIGNING_SECRET?.trim() || undefined;
}

export async function GET(request: Request) {
  try {
    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    const workspaceId = workspaceIdFrom(request);
    const detailLevel = new URL(request.url).searchParams.get("details") ?? "summary";
    if (detailLevel !== "summary" && detailLevel !== "full") {
      throw new ApiError(400, "invalid_handoff_detail_level", "details must be summary or full.");
    }
    if (detailLevel === "full") {
      const requestedTaskId = taskIdFrom(request);
      const principal = await authenticateHandoffIdentity(request, handoffSigningSecret(), {
        workspaceId,
        taskId: requestedTaskId,
      });
      if (principal.taskId && !requestedTaskId) {
        throw new ApiError(403, "handoff_identity_scope_forbidden", "A task-scoped identity must request that exact task.");
      }
    }
    const result = await listHandoffs(database, workspaceId, taskIdFrom(request), {
      includeDetails: detailLevel === "full",
    });
    return jsonResponse({ ok: true, workspaceId, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  let database: D1Database | undefined;
  let scope: string | undefined;
  let idempotencyKey: string | undefined;
  let ownerToken: string | undefined;
  try {
    const body = await readJsonBody(request);
    const parsed = handoffActionSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    const input = parsed.data;
    const principal = await authenticateHandoffIdentity(
      request,
      handoffSigningSecret(),
      {
        workspaceId: input.workspaceId,
        taskId: input.action === "create" ? input.taskId : undefined,
      },
    );
    if (input.action === "create") {
      if (principal.kind !== "worker" || principal.role !== input.fromRole) throw new ApiError(403, "handoff_identity_role_forbidden", "The signed worker identity must match the submitting role.");
    } else if (input.action === "accept") {
      if (principal.kind !== "worker") throw new ApiError(403, "handoff_worker_required", "A worker identity is required to accept a handoff.");
    } else if (input.action === "review") {
      if (principal.kind !== "worker" || principal.role !== "reviewer") throw new ApiError(403, "reviewer_identity_required", "A signed reviewer identity is required.");
    } else if (principal.kind !== "human") {
      throw new ApiError(403, "human_approval_required", "A signed human identity is required for conflict resolution and publication.");
    }
    idempotencyKey = requireIdempotencyKey(request, input.idempotencyKey);
    scope = `handoff:${input.workspaceId}`;
    database = getDatabase();
    await ensureEnvironmentDatabase(database);
    const claim = await claimIdempotency(database, scope, idempotencyKey, await digest(JSON.stringify(input)));
    if (claim.kind === "replay") return jsonResponse(claim.body, claim.status);
    if (claim.kind === "conflict") throw new ApiError(409, "idempotency_key_conflict", "This idempotency key was already used for a different handoff request.");
    if (claim.kind === "in_progress") throw new ApiError(409, "request_in_progress", "A handoff request with this idempotency key is still running.");
    ownerToken = claim.ownerToken;

    let result: unknown;
    let status = 200;
    if (input.action === "create") { result = await createHandoff(database, { ...input, submittedBy: principal.actorId }); status = 201; }
    else if (input.action === "accept") result = await acceptHandoff(database, { ...input, role: principal.role, actor: principal.actorId, taskScope: principal.taskId });
    else if (input.action === "review") result = await reviewHandoff(database, { ...input, reviewerId: principal.actorId, taskScope: principal.taskId });
    else if (input.action === "resolve") result = await resolveHandoff(database, { ...input, actor: principal.actorId, humanApproved: true, taskScope: principal.taskId });
    else result = await publishHandoff(database, { ...input, actor: principal.actorId, humanApproved: true, taskScope: principal.taskId });
    const responseBody = { ok: true, action: input.action, handoff: result };
    await completeIdempotency(database, scope, idempotencyKey, ownerToken, status, responseBody);
    return jsonResponse(responseBody, status);
  } catch (error) {
    const responseBody = error instanceof ApiError
      ? { ok: false, error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }
      : { ok: false, error: { code: "internal_error", message: "The handoff request could not be completed." } };
    if (database && scope && idempotencyKey && ownerToken) {
      await storeIdempotentError(database, scope, idempotencyKey, ownerToken, error instanceof ApiError ? error.status : 500, responseBody).catch(() => undefined);
    }
    return errorResponse(error);
  }
}
