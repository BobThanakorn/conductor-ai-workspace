import { env } from "cloudflare:workers";

import { ApiError, type WorkspaceAction } from "@/lib/api-contract";
import type { AgentEnvironmentBindings } from "@/lib/agent-provider";

export const DEFAULT_WORKSPACE_ID = "workspace_local";

type EnvironmentBindings = AgentEnvironmentBindings & {
  DB?: D1Database;
};

type WorkspaceRow = {
  id: string;
  name: string;
  repository_name: string;
  repository_path: string;
  provider: string;
  default_branch: string;
  active_branch: string;
  base_sha: string;
  head_sha: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type TaskRow = {
  id: string;
  workspace_id: string;
  title: string;
  goal: string;
  status: string;
  risk_level: string;
  branch: string;
  base_sha: string;
  actor: string;
  progress: number;
  model: string | null;
  cancellation_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type ApprovalRow = {
  id: string;
  workspace_id: string;
  task_id: string;
  action: string;
  summary: string;
  risk_level: string;
  status: string;
  details_json: string;
  action_digest: string;
  requested_by: string;
  requested_at: string;
  expires_at: string;
  decided_by: string | null;
  decision_note: string | null;
  decided_at: string | null;
};

type EventRow = {
  sequence: number;
  event_id: string;
  workspace_id: string;
  task_id: string | null;
  type: string;
  actor: string;
  summary: string;
  payload_json: string;
  created_at: string;
};

type IdempotencyRow = {
  request_hash: string;
  status: "pending" | "completed" | "failed";
  owner_token: string;
  response_status: number | null;
  response_json: string | null;
};

export type AgentContext = {
  workspace: {
    id: string;
    name: string;
    repository: string;
    activeBranch: string;
    defaultBranch: string;
    baseSha: string;
  };
  task: null | {
    id: string;
    title: string;
    goal: string;
    status: string;
    riskLevel: string;
    branch: string;
  };
};

export type IdempotencyClaim =
  | { kind: "claimed"; ownerToken: string }
  | { kind: "replay"; status: number; body: Record<string, unknown> }
  | { kind: "conflict" }
  | { kind: "in_progress" };

const bindings = env as unknown as EnvironmentBindings;

let initializedDatabase: D1Database | undefined;
let initialization: Promise<void> | undefined;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repository_name TEXT NOT NULL,
    repository_path TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'github',
    default_branch TEXT NOT NULL DEFAULT 'main',
    active_branch TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'R1',
    branch TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'Human + Agent',
    progress INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    created_by_idempotency_key TEXT NOT NULL,
    last_transition_key TEXT,
    cancellation_reason TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(workspace_id, created_by_idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    details_json TEXT NOT NULL DEFAULT '{}',
    action_digest TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    decided_by TEXT,
    decision_note TEXT,
    decision_event_id TEXT,
    decision_idempotency_key TEXT,
    decided_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS task_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    task_id TEXT REFERENCES tasks(id),
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    task_id TEXT REFERENCES tasks(id),
    idempotency_key TEXT NOT NULL,
    mode TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    output_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(workspace_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    owner_token TEXT NOT NULL,
    response_status INTEGER,
    response_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(scope, key)
  )`,
  "CREATE INDEX IF NOT EXISTS tasks_workspace_status_idx ON tasks(workspace_id, status)",
  "CREATE INDEX IF NOT EXISTS approvals_workspace_status_idx ON approvals(workspace_id, status)",
  "CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals(task_id)",
  "CREATE INDEX IF NOT EXISTS task_events_workspace_sequence_idx ON task_events(workspace_id, sequence)",
  "CREATE INDEX IF NOT EXISTS task_events_task_sequence_idx ON task_events(task_id, sequence)",
  "CREATE INDEX IF NOT EXISTS agent_runs_task_idx ON agent_runs(task_id)",
  `CREATE TRIGGER IF NOT EXISTS task_events_no_update
    BEFORE UPDATE ON task_events
    BEGIN SELECT RAISE(ABORT, 'task_events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS task_events_no_delete
    BEFORE DELETE ON task_events
    BEGIN SELECT RAISE(ABORT, 'task_events are append-only'); END`,
];

export function getEnvironmentBindings(): EnvironmentBindings {
  return bindings;
}

export function getDatabase(): D1Database {
  const database = bindings.DB;
  if (!database || typeof database.prepare !== "function") {
    throw new ApiError(
      503,
      "database_unavailable",
      "The Cloudflare D1 binding `DB` is not configured.",
    );
  }
  return database;
}

export async function ensureEnvironmentDatabase(
  database: D1Database,
): Promise<void> {
  if (database === initializedDatabase && initialization) {
    return initialization;
  }

  initializedDatabase = database;
  initialization = initialize(database).catch((error) => {
    initializedDatabase = undefined;
    initialization = undefined;
    throw error;
  });
  return initialization;
}

async function initialize(database: D1Database): Promise<void> {
  await database.batch(
    schemaStatements.map((statement) => database.prepare(statement)),
  );

  await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO workspaces
          (id, name, repository_name, repository_path, provider, default_branch,
           active_branch, base_sha, head_sha, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        DEFAULT_WORKSPACE_ID,
        "Local workspace",
        "No repository connected",
        "",
        "local",
        "",
        "",
        "",
        "",
        "disconnected",
      ),
    database.prepare(`CREATE TRIGGER IF NOT EXISTS task_events_no_update
      BEFORE UPDATE ON task_events
      BEGIN SELECT RAISE(ABORT, 'task_events are append-only'); END`),
    database.prepare(`CREATE TRIGGER IF NOT EXISTS task_events_no_delete
      BEFORE DELETE ON task_events
      BEGIN SELECT RAISE(ABORT, 'task_events are append-only'); END`),
  ]);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapTask(row: TaskRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    goal: row.goal,
    status: row.status,
    riskLevel: row.risk_level,
    branch: row.branch,
    baseSha: row.base_sha,
    actor: row.actor,
    progress: row.progress,
    model: row.model,
    cancellationReason: row.cancellation_reason,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapApproval(row: ApprovalRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    action: row.action,
    summary: row.summary,
    riskLevel: row.risk_level,
    status: row.status,
    details: parseJson<Record<string, unknown>>(row.details_json, {}),
    actionDigest: row.action_digest,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    decidedAt: row.decided_at,
  };
}

function mapEvent(row: EventRow) {
  return {
    sequence: row.sequence,
    id: row.event_id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    type: row.type,
    actor: row.actor,
    summary: row.summary,
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    createdAt: row.created_at,
  };
}

export async function loadWorkspaceEvents(
  database: D1Database,
  workspaceId: string,
  options: { afterSequence?: number; limit: number; taskId?: string },
) {
  const afterSequence = options.afterSequence ?? 0;
  const requestedLimit = Math.min(Math.max(options.limit, 1), 100);
  const eventStatement = options.taskId
    ? database
        .prepare(
          `SELECT * FROM task_events
           WHERE workspace_id = ? AND task_id = ? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .bind(workspaceId, options.taskId, afterSequence, requestedLimit + 1)
    : database
        .prepare(
          `SELECT * FROM task_events
           WHERE workspace_id = ? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .bind(workspaceId, afterSequence, requestedLimit + 1);

  const [workspaceResult, eventResult] = await database.batch([
    database.prepare("SELECT id FROM workspaces WHERE id = ? LIMIT 1").bind(workspaceId),
    eventStatement,
  ]);
  if (!workspaceResult.results[0]) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found.");
  }

  const rows = eventResult.results as unknown as EventRow[];
  const hasMore = rows.length > requestedLimit;
  const events = rows.slice(0, requestedLimit).map(mapEvent);
  const nextAfterSequence = events.at(-1)?.sequence ?? afterSequence;

  return {
    events,
    cursor: {
      afterSequence: nextAfterSequence,
      hasMore,
      limit: requestedLimit,
    },
  };
}

export async function loadWorkspaceState(
  database: D1Database,
  workspaceId = DEFAULT_WORKSPACE_ID,
  selectedTaskId?: string,
) {
  const [workspaceResult, taskResult, approvalResult, eventResult, runResult] =
    await database.batch([
      database.prepare("SELECT * FROM workspaces WHERE id = ? LIMIT 1").bind(workspaceId),
      database
        .prepare(
          "SELECT * FROM tasks WHERE workspace_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50",
        )
        .bind(workspaceId),
      database
        .prepare(
          `SELECT * FROM approvals WHERE workspace_id = ?
           ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, requested_at DESC
           LIMIT 50`,
        )
        .bind(workspaceId),
      database
        .prepare(
          "SELECT * FROM task_events WHERE workspace_id = ? ORDER BY sequence DESC LIMIT 100",
        )
        .bind(workspaceId),
      database
        .prepare(
          selectedTaskId
            ? `SELECT id, task_id, mode, model, output_json, created_at
               FROM agent_runs WHERE workspace_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 10`
            : `SELECT id, task_id, mode, model, output_json, created_at
               FROM agent_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 10`,
        )
        .bind(...(selectedTaskId ? [workspaceId, selectedTaskId] : [workspaceId])),
    ]);

  const workspace = workspaceResult.results[0] as WorkspaceRow | undefined;
  if (!workspace) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found.");
  }

  const taskRows = taskResult.results as unknown as TaskRow[];
  const approvalRows = approvalResult.results as unknown as ApprovalRow[];
  const eventRows = eventResult.results as unknown as EventRow[];
  const tasks = taskRows.map(mapTask);
  const approvals = approvalRows.map(mapApproval);
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");

  const selectedTask = selectedTaskId
    ? tasks.find((task) => task.id === selectedTaskId) ?? null
    : null;

  return {
    ok: true,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      status: workspace.status,
      repository: {
        name: workspace.repository_name,
        path: workspace.repository_path,
        provider: workspace.provider,
        defaultBranch: workspace.default_branch,
        activeBranch: workspace.active_branch,
        baseSha: workspace.base_sha,
        headSha: workspace.head_sha,
      },
      environment: {
        runner: "Local execution companion",
        sandbox: "workspace-scoped container when connected",
        network: "runtime configured",
        policy: "human-gated R1+ mutations",
      },
      createdAt: workspace.created_at,
      updatedAt: workspace.updated_at,
    },
    tasks,
    activeTask: selectedTask ??
      tasks.find((task) =>
        ["planning", "approved_pending_execution", "executing", "validating", "waiting_for_approval"].includes(
          task.status,
        ),
      ) ?? null,
    approvals,
    pendingApprovals,
    events: eventRows.map(mapEvent),
    recentAgentRuns: runResult.results.map((row) => {
      const value = row as Record<string, unknown>;
      const output = parseJson<Record<string, unknown>>(
        typeof value.output_json === "string" ? value.output_json : null,
        {},
      );
      return {
        id: value.id,
        taskId: value.task_id,
        mode: value.mode,
        model: value.model,
        createdAt: value.created_at,
        summary: typeof output.summary === "string" ? output.summary.slice(0, 240) : "Agent response recorded.",
        plan: Array.isArray(output.plan)
          ? output.plan.filter((step): step is string => typeof step === "string").slice(0, 12)
          : [],
      };
    }),
    meta: {
      eventOrder: "newest_first",
      generatedAt: new Date().toISOString(),
    },
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function canonicalRequest(value: unknown): string {
  return stableStringify(value);
}

export async function claimIdempotency(
  database: D1Database,
  scope: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyClaim> {
  const ownerToken = crypto.randomUUID();
  await database
    .prepare(
      `INSERT OR IGNORE INTO idempotency_keys
        (scope, key, request_hash, status, owner_token)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .bind(scope, key, requestHash, ownerToken)
    .run();

  let row = await database
    .prepare(
      `SELECT request_hash, status, owner_token, response_status, response_json
       FROM idempotency_keys WHERE scope = ? AND key = ?`,
    )
    .bind(scope, key)
    .first<IdempotencyRow>();

  if (!row) {
    throw new ApiError(500, "idempotency_error", "Unable to reserve the request.");
  }
  if (row.request_hash !== requestHash) return { kind: "conflict" };
  if (row.owner_token === ownerToken) return { kind: "claimed", ownerToken };

  if ((row.status === "completed" || row.status === "failed") && row.response_json) {
    return {
      kind: "replay",
      status: row.response_status ?? 200,
      body: {
        ...parseJson<Record<string, unknown>>(row.response_json, {}),
        replayed: true,
      },
    };
  }

  await database
    .prepare(
      `UPDATE idempotency_keys SET owner_token = ?, updated_at = CURRENT_TIMESTAMP
       WHERE scope = ? AND key = ? AND status = 'pending'
         AND datetime(updated_at) <= datetime('now', '-2 minutes')`,
    )
    .bind(ownerToken, scope, key)
    .run();

  row = await database
    .prepare(
      `SELECT request_hash, status, owner_token, response_status, response_json
       FROM idempotency_keys WHERE scope = ? AND key = ?`,
    )
    .bind(scope, key)
    .first<IdempotencyRow>();

  return row?.owner_token === ownerToken
    ? { kind: "claimed", ownerToken }
    : { kind: "in_progress" };
}

export async function storeIdempotentError(
  database: D1Database,
  scope: string,
  key: string,
  ownerToken: string,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await database
    .prepare(
      `UPDATE idempotency_keys
       SET status = 'failed', response_status = ?, response_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE scope = ? AND key = ? AND owner_token = ?`,
    )
    .bind(status, JSON.stringify(body), scope, key, ownerToken)
    .run();
}

function completedIdempotencyStatement(
  database: D1Database,
  scope: string,
  key: string,
  ownerToken: string,
  status: number,
  body: Record<string, unknown>,
) {
  return database
    .prepare(
      `UPDATE idempotency_keys
       SET status = 'completed', response_status = ?, response_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE scope = ? AND key = ? AND owner_token = ?`,
    )
    .bind(status, JSON.stringify(body), scope, key, ownerToken);
}

function changed(result: unknown): number {
  const value = result as { meta?: { changes?: number } } | undefined;
  return Number(value?.meta?.changes ?? 0);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "task"
  );
}

export async function executeWorkspaceAction(
  database: D1Database,
  input: WorkspaceAction,
  workspaceId: string,
  scope: string,
  key: string,
  ownerToken: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (input.action === "create_task") {
    const workspace = await database
      .prepare("SELECT base_sha FROM workspaces WHERE id = ?")
      .bind(workspaceId)
      .first<{ base_sha: string }>();
    if (!workspace) throw new ApiError(404, "workspace_not_found", "Workspace not found.");

    const suffix = (await digest(`${scope}:${key}`)).slice(0, 12);
    const taskId = `task_${suffix}`;
    const eventId = `evt_task_created_${suffix}`;
    const branch = input.branch ?? `agent/${slug(input.title)}-${suffix.slice(0, 6)}`;
    const createdAt = new Date().toISOString();
    const task = {
      id: taskId,
      workspaceId,
      title: input.title,
      goal: input.goal,
      status: "planning",
      riskLevel: input.riskLevel,
      branch,
      baseSha: workspace.base_sha,
      actor: "Human + Coding Agent",
      progress: 5,
      model: null,
      cancellationReason: null,
      version: 1,
      createdAt,
      updatedAt: createdAt,
    };
    const body = {
      ok: true,
      action: input.action,
      replayed: false,
      task,
      eventId,
    };

    const results = await database.batch([
      database
        .prepare(
          `INSERT OR IGNORE INTO tasks
            (id, workspace_id, title, goal, status, risk_level, branch, base_sha,
             actor, progress, created_by_idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'planning', ?, ?, ?, ?, 5, ?, ?, ?)`,
        )
        .bind(
          taskId,
          workspaceId,
          input.title,
          input.goal,
          input.riskLevel,
          branch,
          workspace.base_sha,
          "Human + Coding Agent",
          key,
          createdAt,
          createdAt,
        ),
      database
        .prepare(
          `INSERT OR IGNORE INTO task_events
            (event_id, workspace_id, task_id, type, actor, summary, payload_json, created_at)
           SELECT ?, workspace_id, id, 'task.created', ?, ?, ?, ?
           FROM tasks WHERE id = ? AND created_by_idempotency_key = ?`,
        )
        .bind(
          eventId,
          "Human",
          `Task created: ${input.title}`,
          JSON.stringify({ branch, riskLevel: input.riskLevel }),
          createdAt,
          taskId,
          key,
        ),
      database
        .prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?")
        .bind(createdAt, workspaceId),
      completedIdempotencyStatement(database, scope, key, ownerToken, 201, body),
    ]);
    if (changed(results[0]) !== 1) {
      throw new ApiError(409, "task_creation_conflict", "The task could not be created.");
    }
    return { status: 201, body };
  }

  if (input.action === "approve" || input.action === "reject") {
    const current = await database
      .prepare(
        `SELECT a.*, t.status AS task_status
         FROM approvals a JOIN tasks t ON t.id = a.task_id
         WHERE a.id = ? AND a.workspace_id = ?`,
      )
      .bind(input.approvalId, workspaceId)
      .first<ApprovalRow & { task_status: string }>();
    if (!current) throw new ApiError(404, "approval_not_found", "Approval not found.");
    if (current.status !== "pending") {
      throw new ApiError(409, "approval_already_decided", "This approval is no longer pending.");
    }

    const decision = input.action === "approve" ? "approved" : "rejected";
    // Approval records permission; it does not itself execute a local command.
    const taskStatus = decision === "approved" ? "approved_pending_execution" : "blocked";
    const actor = input.actor ?? "Workspace operator";
    const suffix = (await digest(`${scope}:${key}`)).slice(0, 12);
    const eventId = `evt_approval_${decision}_${suffix}`;
    const decidedAt = new Date().toISOString();
    const body = {
      ok: true,
      action: input.action,
      replayed: false,
      approval: {
        id: current.id,
        taskId: current.task_id,
        status: decision,
        decidedBy: actor,
        decisionNote: input.note ?? null,
        decidedAt,
      },
      transition: { from: current.task_status, to: taskStatus },
      eventId,
    };

    const results = await database.batch([
      database
        .prepare(
          `UPDATE approvals SET status = ?, decided_by = ?, decision_note = ?,
             decision_event_id = ?, decision_idempotency_key = ?, decided_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'pending'
             AND datetime(expires_at) > datetime('now')`,
        )
        .bind(
          decision,
          actor,
          input.note ?? null,
          eventId,
          key,
          decidedAt,
          input.approvalId,
          workspaceId,
        ),
      database
        .prepare(
          `UPDATE tasks SET status = ?, progress = CASE WHEN ? = 'approved_pending_execution' THEN MAX(progress, 72) ELSE progress END,
             last_transition_key = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND EXISTS (
             SELECT 1 FROM approvals WHERE id = ? AND decision_event_id = ?
           )`,
        )
        .bind(
          taskStatus,
          taskStatus,
          key,
          decidedAt,
          current.task_id,
          input.approvalId,
          eventId,
        ),
      database
        .prepare(
          `INSERT OR IGNORE INTO task_events
            (event_id, workspace_id, task_id, type, actor, summary, payload_json, created_at)
           SELECT ?, workspace_id, task_id, ?, ?, ?, ?, ? FROM approvals
           WHERE id = ? AND decision_event_id = ?`,
        )
        .bind(
          eventId,
          `approval.${decision}`,
          actor,
          `Approval ${decision}: ${current.summary}`,
          JSON.stringify({ approvalId: current.id, note: input.note ?? null }),
          decidedAt,
          input.approvalId,
          eventId,
        ),
      database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").bind(decidedAt, workspaceId),
      completedIdempotencyStatement(database, scope, key, ownerToken, 200, body),
    ]);
    if (changed(results[0]) !== 1) {
      throw new ApiError(
        409,
        "approval_state_conflict",
        "The approval expired or was decided by another request.",
      );
    }
    return { status: 200, body };
  }

  const current = await database
    .prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?")
    .bind(input.taskId, workspaceId)
    .first<TaskRow>();
  if (!current) throw new ApiError(404, "task_not_found", "Task not found.");

  const isCancel = input.action === "cancel";
  const allowed = isCancel
    ? !["cancelled", "completed"].includes(current.status)
    : ["cancelled", "blocked", "failed"].includes(current.status);
  if (!allowed) {
    throw new ApiError(
      409,
      "invalid_task_transition",
      `Task cannot ${input.action} from status ${current.status}.`,
    );
  }

  const actor = input.actor ?? "Workspace operator";
  const nextStatus = isCancel ? "cancelled" : "planning";
  const note = isCancel ? input.reason : input.note;
  const suffix = (await digest(`${scope}:${key}`)).slice(0, 12);
  const eventId = `evt_task_${input.action}_${suffix}`;
  const changedAt = new Date().toISOString();
  const body = {
    ok: true,
    action: input.action,
    replayed: false,
    task: {
      id: current.id,
      status: nextStatus,
      cancellationReason: isCancel ? note ?? "Cancelled by workspace operator" : null,
      updatedAt: changedAt,
    },
    transition: { from: current.status, to: nextStatus },
    eventId,
  };

  const statements = [
    database
      .prepare(
        isCancel
          ? `UPDATE tasks SET status = 'cancelled', cancellation_reason = ?, last_transition_key = ?,
               version = version + 1, updated_at = ?
             WHERE id = ? AND workspace_id = ? AND status NOT IN ('cancelled', 'completed')`
          : `UPDATE tasks SET status = 'planning', cancellation_reason = NULL, last_transition_key = ?,
               progress = MIN(progress, 15), version = version + 1, updated_at = ?
             WHERE id = ? AND workspace_id = ? AND status IN ('cancelled', 'blocked', 'failed')`,
      )
      .bind(
        ...(isCancel
          ? [note ?? "Cancelled by workspace operator", key, changedAt, current.id, workspaceId]
          : [key, changedAt, current.id, workspaceId]),
      ),
  ];

  if (isCancel) {
    statements.push(
      database
        .prepare(
          `UPDATE approvals SET status = 'withdrawn', decided_by = 'system',
             decision_note = 'Task cancelled', decided_at = ?
           WHERE task_id = ? AND status = 'pending'
             AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND last_transition_key = ?)`,
        )
        .bind(changedAt, current.id, current.id, key),
    );
  }
  statements.push(
    database
      .prepare(
        `INSERT OR IGNORE INTO task_events
          (event_id, workspace_id, task_id, type, actor, summary, payload_json, created_at)
         SELECT ?, workspace_id, id, ?, ?, ?, ?, ? FROM tasks
         WHERE id = ? AND last_transition_key = ?`,
      )
      .bind(
        eventId,
        `task.${input.action}d`,
        actor,
        `Task ${input.action}d: ${current.title}`,
        JSON.stringify({ note: note ?? null }),
        changedAt,
        current.id,
        key,
      ),
    database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").bind(changedAt, workspaceId),
    completedIdempotencyStatement(database, scope, key, ownerToken, 200, body),
  );

  const results = await database.batch(statements);
  if (changed(results[0]) !== 1) {
    throw new ApiError(409, "task_state_conflict", "Task state changed before the action completed.");
  }
  return { status: 200, body };
}

export async function loadAgentContext(
  database: D1Database,
  workspaceId: string,
  taskId?: string,
): Promise<AgentContext> {
  const workspace = await database
    .prepare("SELECT * FROM workspaces WHERE id = ?")
    .bind(workspaceId)
    .first<WorkspaceRow>();
  if (!workspace) throw new ApiError(404, "workspace_not_found", "Workspace not found.");

  let task: TaskRow | null = null;
  if (taskId) {
    task = await database
      .prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?")
      .bind(taskId, workspaceId)
      .first<TaskRow>();
    if (!task) throw new ApiError(404, "task_not_found", "Task not found.");
  }

  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      repository: workspace.repository_name,
      activeBranch: workspace.active_branch,
      defaultBranch: workspace.default_branch,
      baseSha: workspace.base_sha,
    },
    task: task
      ? {
          id: task.id,
          title: task.title,
          goal: task.goal,
          status: task.status,
          riskLevel: task.risk_level,
          branch: task.branch,
        }
      : null,
  };
}

export async function persistAgentRun(
  database: D1Database,
  options: {
    workspaceId: string;
    taskId?: string;
    scope: string;
    key: string;
    ownerToken: string;
    mode: "azure" | "openai";
    model: string;
    promptHash: string;
    output: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const suffix = (await digest(`${options.scope}:${options.key}`)).slice(0, 16);
  const runId = `run_${suffix}`;
  const eventId = `evt_agent_response_${suffix}`;
  const createdAt = new Date().toISOString();
  const summary =
    typeof options.output.summary === "string"
      ? options.output.summary.slice(0, 240)
      : "Coding agent produced a structured response.";
  const body = {
    ok: true,
    replayed: false,
    runId,
    eventId,
    mode: options.mode,
    model: options.model,
    output: options.output,
    createdAt,
  };

  const needsApproval = options.output.needsApproval === true && Boolean(options.taskId);
  const approvalId = needsApproval ? `approval_${suffix}` : undefined;
  const approvalDigest = needsApproval
    ? await digest(canonicalRequest({
        action: options.output.proposedAction ?? "agent.apply",
        taskId: options.taskId,
        artifacts: options.output.artifacts ?? [],
        execution: options.output.execution ?? null,
      }))
    : undefined;
  const approvalExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const approvalEventId = needsApproval ? `evt_approval_requested_${suffix}` : undefined;
  const statements = [
    database
      .prepare(
        `INSERT OR IGNORE INTO agent_runs
          (id, workspace_id, task_id, idempotency_key, mode, model, prompt_hash, output_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        runId,
        options.workspaceId,
        options.taskId ?? null,
        options.key,
        options.mode,
        options.model,
        options.promptHash,
        JSON.stringify(options.output),
        createdAt,
      ),
    database
      .prepare(
        `INSERT OR IGNORE INTO task_events
          (event_id, workspace_id, task_id, type, actor, summary, payload_json, created_at)
         VALUES (?, ?, ?, 'agent.response.generated', 'Coding Agent', ?, ?, ?)`,
      )
      .bind(
        eventId,
        options.workspaceId,
        options.taskId ?? null,
        summary,
        JSON.stringify({
          runId,
          mode: options.mode,
          model: options.model,
          status: options.output.status,
          riskLevel: options.output.riskLevel,
        }),
        createdAt,
      ),
  ];

  if (needsApproval && approvalId && approvalDigest && approvalEventId) {
    statements.push(
      database
        .prepare(
          `INSERT OR IGNORE INTO approvals
            (id, workspace_id, task_id, action, summary, risk_level, status, details_json,
             action_digest, requested_by, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'Coding Agent', ?)`,
        )
        .bind(
          approvalId,
          options.workspaceId,
          options.taskId,
          typeof options.output.proposedAction === "string" ? options.output.proposedAction : "agent.apply",
          summary,
          typeof options.output.riskLevel === "string" ? options.output.riskLevel : "R1",
          JSON.stringify({
            runId,
            artifacts: options.output.artifacts ?? [],
            execution: options.output.execution ?? null,
            proposal: options.output,
          }),
          approvalDigest,
          approvalExpiresAt,
        ),
      database
        .prepare(
          `INSERT OR IGNORE INTO task_events
            (event_id, workspace_id, task_id, type, actor, summary, payload_json, created_at)
           VALUES (?, ?, ?, 'approval.requested', 'Coding Agent', ?, ?, ?)`,
        )
        .bind(
          approvalEventId,
          options.workspaceId,
          options.taskId,
          `Approval required: ${summary}`,
          JSON.stringify({ approvalId, actionDigest: approvalDigest, expiresAt: approvalExpiresAt }),
          createdAt,
        ),
      database
        .prepare(
          `UPDATE tasks SET status = 'waiting_for_approval', progress = MAX(progress, 60), updated_at = ?
           WHERE id = ? AND workspace_id = ? AND status NOT IN ('completed', 'cancelled')`,
        )
        .bind(createdAt, options.taskId, options.workspaceId),
    );
  }

  statements.push(
    completedIdempotencyStatement(
      database,
      options.scope,
      options.key,
      options.ownerToken,
      200,
      {
        ...body,
        ...(approvalId ? { approvalId, approvalExpiresAt } : {}),
      },
    ),
  );

  const results = await database.batch(statements);
  if (changed(results[0]) !== 1) {
    throw new ApiError(409, "agent_run_conflict", "The agent run already exists.");
  }
  return {
    ...body,
    ...(approvalId ? { approvalId, approvalExpiresAt } : {}),
  };
}
