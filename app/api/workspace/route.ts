import {
  ApiError,
  errorResponse,
  jsonResponse,
  readJsonBody,
  requireIdempotencyKey,
  validationError,
  workspaceActionSchema,
} from "@/lib/api-contract";
import {
  DEMO_WORKSPACE_ID,
  claimIdempotency,
  canonicalRequest,
  digest,
  ensureEnvironmentDatabase,
  executeWorkspaceAction,
  getDatabase,
  loadWorkspaceState,
  storeIdempotentError,
} from "@/lib/environment-store";

export const dynamic = "force-dynamic";

function requestedWorkspaceId(request: Request): string {
  return new URL(request.url).searchParams.get("workspaceId")?.trim() ||
    DEMO_WORKSPACE_ID;
}

function errorBody(error: unknown): { ok: false; error: Record<string, unknown> } {
  if (error instanceof ApiError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }

  return {
    ok: false,
    error: {
      code: "internal_error",
      message: "The request could not be completed.",
    },
  };
}

export async function GET(request: Request) {
  try {
    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    const state = await loadWorkspaceState(database, requestedWorkspaceId(request));
    const activeTask = state.activeTask ?? state.tasks[0];
    return jsonResponse({
      ...state,
      workspace: {
        ...state.workspace,
        repo: state.workspace.repository.name,
        branch: state.workspace.repository.activeBranch,
        baseBranch: state.workspace.repository.defaultBranch,
        taskId: activeTask?.id,
        taskTitle: activeTask?.title,
      },
      events: state.events.map((event) => ({
        ...event,
        title: event.type.replaceAll(".", " "),
        detail: event.summary,
        state: event.type.includes("requested") ? "active" : "complete",
      })),
    });
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
    const parsed = workspaceActionSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);

    const action = parsed.data;
    idempotencyKey = requireIdempotencyKey(request, action.idempotencyKey);
    const workspaceId = action.workspaceId ?? requestedWorkspaceId(request);
    scope = `workspace:${workspaceId}`;
    database = getDatabase();
    await ensureEnvironmentDatabase(database);

    const claim = await claimIdempotency(
      database,
      scope,
      idempotencyKey,
      await digest(canonicalRequest(action)),
    );
    if (claim.kind === "replay") return jsonResponse(claim.body, claim.status);
    if (claim.kind === "conflict") {
      throw new ApiError(
        409,
        "idempotency_key_conflict",
        "This idempotency key was already used for a different request.",
      );
    }
    if (claim.kind === "in_progress") {
      throw new ApiError(
        409,
        "request_in_progress",
        "A request with this idempotency key is still running.",
      );
    }

    ownerToken = claim.ownerToken;
    const result = await executeWorkspaceAction(
      database,
      action,
      workspaceId,
      scope,
      idempotencyKey,
      ownerToken,
    );
    return jsonResponse(result.body, result.status);
  } catch (error) {
    const body = errorBody(error);
    if (database && scope && idempotencyKey && ownerToken) {
      await storeIdempotentError(
        database,
        scope,
        idempotencyKey,
        ownerToken,
        error instanceof ApiError ? error.status : 500,
        body,
      ).catch(() => undefined);
    }
    return errorResponse(error);
  }
}
