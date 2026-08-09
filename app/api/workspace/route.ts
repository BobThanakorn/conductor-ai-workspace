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
  DEFAULT_WORKSPACE_ID,
  claimIdempotency,
  canonicalRequest,
  digest,
  ensureEnvironmentDatabase,
  executeWorkspaceAction,
  getDatabase,
  loadWorkspaceEvents,
  loadTaskQueue,
  loadWorkspaceState,
  storeIdempotentError,
} from "@/lib/environment-store";

export const dynamic = "force-dynamic";

function requestedWorkspaceId(request: Request): string {
  return new URL(request.url).searchParams.get("workspaceId")?.trim() ||
    DEFAULT_WORKSPACE_ID;
}

function requestedTaskId(request: Request): string | undefined {
  const value = new URL(request.url).searchParams.get("taskId")?.trim();
  if (!value) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new ApiError(400, "invalid_task_id", "taskId is not valid.");
  }
  return value;
}

function parseEventQuery(request: Request): {
  eventsOnly: boolean;
  afterSequence?: number;
  limit: number;
  taskId?: string;
} {
  const params = new URL(request.url).searchParams;
  const view = params.get("view");
  if (view && view !== "state" && view !== "events" && view !== "queue") {
    throw new ApiError(400, "invalid_view", "view must be state, events, or queue.");
  }

  const rawAfter = params.get("afterSequence");
  const rawLimit = params.get("eventLimit") ?? params.get("limit");
  const afterSequence = rawAfter === null ? undefined : Number(rawAfter);
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (
    afterSequence !== undefined &&
    (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
  ) {
    throw new ApiError(
      400,
      "invalid_event_cursor",
      "afterSequence must be a non-negative safe integer.",
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(
      400,
      "invalid_event_limit",
      "eventLimit must be an integer between 1 and 100.",
    );
  }

  const taskId = params.get("taskId")?.trim() || undefined;
  if (taskId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(taskId)) {
    throw new ApiError(400, "invalid_task_id", "taskId is not valid.");
  }
  return {
    eventsOnly: view === "events" || afterSequence !== undefined,
    afterSequence,
    limit,
    taskId,
  };
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
    const workspaceId = requestedWorkspaceId(request);
    const eventQuery = parseEventQuery(request);
    const view = new URL(request.url).searchParams.get("view");
    if (view === "queue") {
      const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "invalid_queue_limit", "limit must be between 1 and 100.");
      const queue = await loadTaskQueue(database, workspaceId, limit);
      return jsonResponse({ ok: true, workspaceId, ...queue });
    }
    if (eventQuery.eventsOnly) {
      const page = await loadWorkspaceEvents(database, workspaceId, {
        afterSequence: eventQuery.afterSequence,
        limit: eventQuery.limit,
        taskId: eventQuery.taskId,
      });
      return jsonResponse({
        ok: true,
        workspaceId,
        ...page,
        meta: { order: "oldest_first", generatedAt: new Date().toISOString() },
      });
    }

    const state = await loadWorkspaceState(database, workspaceId, requestedTaskId(request));
    const activeTask = state.activeTask ?? state.tasks[0];
    const latestSequence = state.events.reduce(
      (highest, event) => Math.max(highest, event.sequence),
      0,
    );
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
      eventStream: {
        endpoint: `/api/workspace?view=events&workspaceId=${encodeURIComponent(workspaceId)}`,
        afterSequence: latestSequence,
        maxPageSize: 100,
      },
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
