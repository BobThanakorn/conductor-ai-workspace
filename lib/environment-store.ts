import { env } from "cloudflare:workers";

import { ApiError, type WorkspaceAction } from "@/lib/api-contract";
import type { AgentEnvironmentBindings } from "@/lib/agent-provider";
import type { AgentTelemetry } from "@/lib/agent-telemetry";
import type { AgentMutationPayload } from "@/lib/agent-contract";

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

export type RepositoryRegistration = {
  name: string;
  path: string;
  provider: "local" | "github";
  defaultBranch: string;
  activeBranch: string;
  baseSha: string;
  headSha: string;
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
  lease_owner: string | null;
  lease_expires_at: string | null;
  attempt_count: number;
  checkpoint_id: string | null;
  max_attempts: number;
  retry_count: number;
  retry_after: string | null;
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
    lease_owner TEXT,
    lease_expires_at TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    checkpoint_id TEXT,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    retry_count INTEGER NOT NULL DEFAULT 0,
    retry_after TEXT,
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
  `CREATE TABLE IF NOT EXISTS task_dependencies (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
    PRIMARY KEY(workspace_id, task_id, depends_on_task_id)
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
  `CREATE TABLE IF NOT EXISTS agent_run_audit (
    run_id TEXT PRIMARY KEY REFERENCES agent_runs(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    engine TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    token_usage_json TEXT NOT NULL DEFAULT '{}',
    tools_json TEXT NOT NULL DEFAULT '[]',
    audit_log_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    from_role TEXT NOT NULL,
    to_role TEXT NOT NULL,
    submitted_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    context_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    evidence_digest TEXT NOT NULL,
    created_at TEXT NOT NULL,
    accepted_by TEXT,
    accepted_at TEXT,
    published_by TEXT,
    published_at TEXT,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS handoff_reviews (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    handoff_id TEXT NOT NULL REFERENCES handoffs(id),
    reviewer_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    evidence_digest TEXT NOT NULL,
    human_approved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_servers (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    server_id TEXT NOT NULL,
    allowlist_id TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'registered',
    enabled INTEGER NOT NULL DEFAULT 0,
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    tools_json TEXT NOT NULL DEFAULT '[]',
    revision INTEGER NOT NULL DEFAULT 1,
    last_error_code TEXT,
    last_checked_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, server_id)
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_registry_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    server_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    detail_code TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_policy_state (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_tool_policies (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    scope_type TEXT NOT NULL CHECK(scope_type IN ('workspace', 'agent')),
    scope_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('allow', 'deny', 'inherit')),
    risk TEXT NOT NULL CHECK(risk IN ('read', 'write', 'execute', 'external')),
    requires_approval INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_id, scope_type, scope_id, server_id, tool_name)
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_policy_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    risk TEXT NOT NULL,
    previous_decision TEXT NOT NULL,
    decision TEXT NOT NULL,
    previous_revision INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL
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
  `CREATE TABLE IF NOT EXISTS automation_profiles (
    id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_id TEXT NOT NULL,
    kind TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(workspace_id, owner_id, kind, id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), owner_id TEXT NOT NULL,
    name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, trigger_json TEXT NOT NULL,
    agent_profile_id TEXT NOT NULL, agent_profile_version INTEGER NOT NULL, skill_profile_id TEXT NOT NULL,
    skill_profile_version INTEGER NOT NULL, next_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, status TEXT NOT NULL, snapshot_id TEXT NOT NULL,
    task_id TEXT, lease_owner TEXT, lease_expires_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
    cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(automation_id, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS automation_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES automation_runs(id),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id), type TEXT NOT NULL, actor_id TEXT NOT NULL,
    detail_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS automation_snapshots (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES automation_runs(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    manifest_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id)
  )`,
  `CREATE TABLE IF NOT EXISTS operations_quota (
    workspace_id TEXT NOT NULL, bucket TEXT NOT NULL, window_start TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id, bucket, window_start)
  )`,
  `CREATE TABLE IF NOT EXISTS operations_audit (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    event_type TEXT NOT NULL, trace_id TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS tasks_workspace_status_idx ON tasks(workspace_id, status)",
  "CREATE INDEX IF NOT EXISTS tasks_workspace_lease_idx ON tasks(workspace_id, lease_expires_at)",
  "CREATE INDEX IF NOT EXISTS task_dependencies_lookup_idx ON task_dependencies(workspace_id, task_id)",
  "CREATE INDEX IF NOT EXISTS approvals_workspace_status_idx ON approvals(workspace_id, status)",
  "CREATE INDEX IF NOT EXISTS approvals_task_idx ON approvals(task_id)",
  "CREATE INDEX IF NOT EXISTS task_events_workspace_sequence_idx ON task_events(workspace_id, sequence)",
  "CREATE INDEX IF NOT EXISTS task_events_task_sequence_idx ON task_events(task_id, sequence)",
  "CREATE INDEX IF NOT EXISTS agent_runs_task_idx ON agent_runs(task_id)",
  "CREATE INDEX IF NOT EXISTS agent_run_audit_workspace_idx ON agent_run_audit(workspace_id, created_at)",
  "CREATE INDEX IF NOT EXISTS handoffs_workspace_task_idx ON handoffs(workspace_id, task_id, created_at)",
  "CREATE INDEX IF NOT EXISTS handoffs_status_idx ON handoffs(workspace_id, status)",
  "CREATE INDEX IF NOT EXISTS handoff_reviews_handoff_idx ON handoff_reviews(handoff_id, created_at)",
  "CREATE INDEX IF NOT EXISTS mcp_servers_workspace_status_idx ON mcp_servers(workspace_id, status, enabled)",
  "CREATE INDEX IF NOT EXISTS mcp_registry_events_workspace_idx ON mcp_registry_events(workspace_id, sequence)",
  "CREATE INDEX IF NOT EXISTS mcp_tool_policies_workspace_idx ON mcp_tool_policies(workspace_id, server_id, tool_name)",
  "CREATE UNIQUE INDEX IF NOT EXISTS mcp_policy_events_idempotency_idx ON mcp_policy_events(workspace_id, idempotency_key)",
  "CREATE UNIQUE INDEX IF NOT EXISTS mcp_policy_events_revision_idx ON mcp_policy_events(workspace_id, revision)",
  "CREATE INDEX IF NOT EXISTS mcp_policy_events_workspace_idx ON mcp_policy_events(workspace_id, sequence)",
  "CREATE INDEX IF NOT EXISTS automations_due_idx ON automations(workspace_id, owner_id, enabled, next_run_at)",
  "CREATE INDEX IF NOT EXISTS automation_runs_queue_idx ON automation_runs(workspace_id, owner_id, status, lease_expires_at)",
  "CREATE INDEX IF NOT EXISTS automation_events_run_idx ON automation_events(run_id, sequence)",
  `CREATE TRIGGER IF NOT EXISTS task_events_no_update
    BEFORE UPDATE ON task_events
    BEGIN SELECT RAISE(ABORT, 'task_events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS task_events_no_delete
    BEFORE DELETE ON task_events
    BEGIN SELECT RAISE(ABORT, 'task_events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS agent_run_audit_no_update
    BEFORE UPDATE ON agent_run_audit
    BEGIN SELECT RAISE(ABORT, 'agent_run_audit is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS agent_run_audit_no_delete
    BEFORE DELETE ON agent_run_audit
    BEGIN SELECT RAISE(ABORT, 'agent_run_audit is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS handoff_reviews_no_update
    BEFORE UPDATE ON handoff_reviews
    BEGIN SELECT RAISE(ABORT, 'handoff_reviews is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS handoff_reviews_no_delete
    BEFORE DELETE ON handoff_reviews
    BEGIN SELECT RAISE(ABORT, 'handoff_reviews is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS handoffs_immutable_payload
    BEFORE UPDATE OF workspace_id, task_id, from_role, to_role, submitted_by,
      context_json, evidence_json, evidence_digest, created_at ON handoffs
    BEGIN SELECT RAISE(ABORT, 'handoff identity, context, and evidence are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS handoffs_no_delete
    BEFORE DELETE ON handoffs
    BEGIN SELECT RAISE(ABORT, 'handoffs cannot be deleted'); END`,
  `CREATE TRIGGER IF NOT EXISTS mcp_registry_events_no_update
    BEFORE UPDATE ON mcp_registry_events
    BEGIN SELECT RAISE(ABORT, 'mcp_registry_events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS mcp_registry_events_no_delete
    BEFORE DELETE ON mcp_registry_events
    BEGIN SELECT RAISE(ABORT, 'mcp_registry_events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS mcp_policy_events_no_update
    BEFORE UPDATE ON mcp_policy_events
    BEGIN SELECT RAISE(ABORT, 'mcp_policy_events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS mcp_policy_events_no_delete
    BEFORE DELETE ON mcp_policy_events
    BEGIN SELECT RAISE(ABORT, 'mcp_policy_events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS automation_events_no_update
    BEFORE UPDATE ON automation_events
    BEGIN SELECT RAISE(ABORT, 'automation_events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS automation_events_no_delete
    BEFORE DELETE ON automation_events
    BEGIN SELECT RAISE(ABORT, 'automation_events are append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS operations_audit_no_update
    BEFORE UPDATE ON operations_audit
    BEGIN SELECT RAISE(ABORT, 'operations_audit is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS operations_audit_no_delete
    BEFORE DELETE ON operations_audit
    BEGIN SELECT RAISE(ABORT, 'operations_audit is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS automation_profiles_no_update
    BEFORE UPDATE ON automation_profiles
    BEGIN SELECT RAISE(ABORT, 'automation_profiles are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS automation_profiles_no_delete
    BEFORE DELETE ON automation_profiles
    BEGIN SELECT RAISE(ABORT, 'automation_profiles are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS automation_snapshots_no_update
    BEFORE UPDATE ON automation_snapshots
    BEGIN SELECT RAISE(ABORT, 'automation_snapshots are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS automation_snapshots_no_delete
    BEFORE DELETE ON automation_snapshots
    BEGIN SELECT RAISE(ABORT, 'automation_snapshots are immutable'); END`,
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
  // Create tables before indexes/triggers. Older persistent D1/SQLite stores
  // may have the table but not the additive queue columns yet; creating the
  // lease index in the same batch would fail before the migrations can run.
  const tableStatements = schemaStatements.filter((statement) =>
    /^\s*CREATE TABLE/i.test(statement),
  );
  const dependentStatements = schemaStatements.filter((statement) =>
    /^\s*CREATE (?:UNIQUE )?(?:INDEX|TRIGGER)/i.test(statement),
  );
  await database.batch(tableStatements.map((statement) => database.prepare(statement)));

  // Existing D1 installations may predate queue leases. Duplicate-column
  // errors are safe because each migration is additive and idempotent.
  for (const statement of [
    "ALTER TABLE tasks ADD COLUMN lease_owner TEXT",
    "ALTER TABLE tasks ADD COLUMN lease_expires_at TEXT",
    "ALTER TABLE tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN checkpoint_id TEXT",
    "ALTER TABLE tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3",
    "ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN retry_after TEXT",
    "ALTER TABLE handoffs ADD COLUMN published_by TEXT",
    "ALTER TABLE handoffs ADD COLUMN published_at TEXT",
    "ALTER TABLE mcp_servers ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
  ]) {
    try {
      await database.prepare(statement).run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column name|already exists/i.test(message)) throw error;
    }
  }

  await database.batch(
    dependentStatements.map((statement) => database.prepare(statement)),
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
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: row.attempt_count,
    checkpointId: row.checkpoint_id,
    maxAttempts: row.max_attempts,
    retryCount: row.retry_count,
    retryAfter: row.retry_after,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRepositories(database: D1Database) {
  const result = await database
    .prepare(
      `SELECT w.*,
         (SELECT COUNT(*) FROM tasks t WHERE t.workspace_id = w.id) AS task_count,
         (SELECT title FROM tasks t WHERE t.workspace_id = w.id
          ORDER BY t.updated_at DESC, t.id DESC LIMIT 1) AS recent_task_title,
         (SELECT status FROM tasks t WHERE t.workspace_id = w.id
          ORDER BY t.updated_at DESC, t.id DESC LIMIT 1) AS recent_task_status,
         (SELECT updated_at FROM tasks t WHERE t.workspace_id = w.id
          ORDER BY t.updated_at DESC, t.id DESC LIMIT 1) AS recent_task_updated_at
       FROM workspaces w
       WHERE w.repository_path <> ''
       ORDER BY w.updated_at DESC, w.name ASC`,
    )
    .all<WorkspaceRow & {
      task_count: number;
      recent_task_title: string | null;
      recent_task_status: string | null;
      recent_task_updated_at: string | null;
    }>();

  return result.results.map((row) => ({
    id: row.id,
    name: row.name,
    repositoryName: row.repository_name,
    path: row.repository_path,
    provider: row.provider,
    defaultBranch: row.default_branch,
    activeBranch: row.active_branch,
    headSha: row.head_sha,
    status: row.status,
    taskCount: Number(row.task_count ?? 0),
    recentTask: row.recent_task_title
      ? {
          title: row.recent_task_title,
          status: row.recent_task_status,
          updatedAt: row.recent_task_updated_at,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function registerRepository(
  database: D1Database,
  registration: RepositoryRegistration,
) {
  const existing = await database
    .prepare("SELECT id FROM workspaces WHERE repository_path = ? LIMIT 1")
    .bind(registration.path)
    .first<{ id: string }>();
  const disconnectedDefault = !existing
    ? await database
        .prepare(
          "SELECT id FROM workspaces WHERE id = ? AND status = 'disconnected' LIMIT 1",
        )
        .bind(DEFAULT_WORKSPACE_ID)
        .first<{ id: string }>()
    : null;
  const id = existing?.id ??
    disconnectedDefault?.id ??
    `repo_${(await digest(registration.path)).slice(0, 16)}`;
  const now = new Date().toISOString();

  await database
    .prepare(
      `INSERT INTO workspaces
        (id, name, repository_name, repository_path, provider, default_branch,
         active_branch, base_sha, head_sha, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         repository_name = excluded.repository_name,
         repository_path = excluded.repository_path,
         provider = excluded.provider,
         default_branch = excluded.default_branch,
         active_branch = excluded.active_branch,
         base_sha = excluded.base_sha,
         head_sha = excluded.head_sha,
         status = 'ready',
         updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      registration.name,
      registration.name,
      registration.path,
      registration.provider,
      registration.defaultBranch,
      registration.activeBranch,
      registration.baseSha,
      registration.headSha,
      now,
      now,
    )
    .run();

  return { id, ...registration, status: "ready", updatedAt: now };
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

export async function loadTaskQueue(database: D1Database, workspaceId: string, limit = 50) {
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const workspace = await database.prepare("SELECT id FROM workspaces WHERE id = ? LIMIT 1").bind(workspaceId).first();
  if (!workspace) throw new ApiError(404, "workspace_not_found", "Workspace not found.");
  const result = await database.prepare(
     `SELECT * FROM tasks
     WHERE workspace_id = ? AND status NOT IN ('completed', 'cancelled')
       AND (retry_after IS NULL OR datetime(retry_after) <= datetime('now'))
       AND NOT EXISTS (
         SELECT 1 FROM task_dependencies d
         JOIN tasks dependency ON dependency.id = d.depends_on_task_id
         WHERE d.workspace_id = tasks.workspace_id
           AND d.task_id = tasks.id
           AND dependency.status NOT IN ('completed')
       )
     ORDER BY CASE WHEN lease_expires_at IS NULL OR datetime(lease_expires_at) <= datetime('now') THEN 0 ELSE 1 END,
              CASE status WHEN 'failed' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END,
              updated_at ASC, id ASC LIMIT ?`,
  ).bind(workspaceId, boundedLimit).all();
  return {
    tasks: (result.results as unknown as TaskRow[]).map(mapTask),
    limit: boundedLimit,
    generatedAt: new Date().toISOString(),
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
            ? `SELECT ar.id, ar.task_id, ar.mode, ar.model, ar.output_json, ar.created_at,
                      aa.question, aa.answer, aa.engine, aa.duration_ms,
                      aa.token_usage_json, aa.tools_json, aa.audit_log_json
               FROM agent_runs ar
               LEFT JOIN agent_run_audit aa ON aa.run_id = ar.id
               WHERE ar.workspace_id = ? AND ar.task_id = ? ORDER BY ar.created_at DESC LIMIT 10`
            : `SELECT ar.id, ar.task_id, ar.mode, ar.model, ar.output_json, ar.created_at,
                      aa.question, aa.answer, aa.engine, aa.duration_ms,
                      aa.token_usage_json, aa.tools_json, aa.audit_log_json
               FROM agent_runs ar
               LEFT JOIN agent_run_audit aa ON aa.run_id = ar.id
               WHERE ar.workspace_id = ?
                 AND ar.task_id = (
                   SELECT id FROM tasks
                   WHERE workspace_id = ?
                   ORDER BY updated_at DESC, id DESC
                   LIMIT 1
                 )
               ORDER BY ar.created_at DESC LIMIT 10`,
        )
        .bind(...(selectedTaskId ? [workspaceId, selectedTaskId] : [workspaceId, workspaceId])),
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
        question: typeof value.question === "string" ? value.question : "",
        answer: typeof value.answer === "string" ? value.answer : "",
        engine: typeof value.engine === "string" ? value.engine : "",
        telemetry: {
          durationMs: typeof value.duration_ms === "number" ? value.duration_ms : 0,
          tokenUsage: parseJson(
            typeof value.token_usage_json === "string" ? value.token_usage_json : null,
            { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          ),
          tools: parseJson(
            typeof value.tools_json === "string" ? value.tools_json : null,
            [],
          ),
          auditLog: parseJson(
            typeof value.audit_log_json === "string" ? value.audit_log_json : null,
            [],
          ),
        },
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

/** Complete an idempotent API request from a route that owns its domain store. */
export async function completeIdempotency(
  database: D1Database,
  scope: string,
  key: string,
  ownerToken: string,
  status: number,
  body: Record<string, unknown>,
): Promise<void> {
  await completedIdempotencyStatement(database, scope, key, ownerToken, status, body).run();
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
    const dependencies = [...new Set(input.dependsOn ?? [])];
    if (dependencies.includes(taskId)) throw new ApiError(409, "task_dependency_self", "A task cannot depend on itself.");
    for (const dependencyId of dependencies) {
      const dependency = await database.prepare("SELECT id FROM tasks WHERE id = ? AND workspace_id = ?").bind(dependencyId, workspaceId).first<{ id: string }>();
      if (!dependency) throw new ApiError(409, "task_dependency_not_found", `Dependency task ${dependencyId} was not found in this workspace.`);
    }
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
      progress: 0,
      model: null,
      cancellationReason: null,
      version: 1,
      createdAt,
      updatedAt: createdAt,
      dependsOn: dependencies,
      maxAttempts: input.maxAttempts ?? 3,
      retryCount: 0,
      retryAfter: null,
    };
    const body = {
      ok: true,
      action: input.action,
      replayed: false,
      task,
      eventId,
    };

    const dependencyStatements = dependencies.map((dependencyId) => database.prepare(
      "INSERT OR IGNORE INTO task_dependencies (workspace_id, task_id, depends_on_task_id) VALUES (?, ?, ?)",
    ).bind(workspaceId, taskId, dependencyId));
    const results = await database.batch([
      database
        .prepare(
          `INSERT OR IGNORE INTO tasks
            (id, workspace_id, title, goal, status, risk_level, branch, base_sha,
            actor, progress, created_by_idempotency_key, created_at, updated_at, max_attempts, retry_count)
           VALUES (?, ?, ?, ?, 'planning', ?, ?, ?, ?, 0, ?, ?, ?, ?, 0)`,
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
          input.maxAttempts ?? 3,
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
          JSON.stringify({ branch, riskLevel: input.riskLevel, dependsOn: dependencies, maxAttempts: input.maxAttempts ?? 3 }),
          createdAt,
          taskId,
          key,
        ),
      database
        .prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?")
        .bind(createdAt, workspaceId),
      ...dependencyStatements,
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

  if (input.action === "fail") {
    const current = await database.prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?").bind(input.taskId, workspaceId).first<TaskRow>();
    if (!current) throw new ApiError(404, "task_not_found", "Task not found.");
    if (["completed", "cancelled"].includes(current.status)) throw new ApiError(409, "task_terminal", "A completed or cancelled task cannot fail.");
    const retryAllowed = input.retryable && current.attempt_count < current.max_attempts;
    const retryCount = retryAllowed ? current.retry_count + 1 : current.retry_count;
    const backoffMs = Math.min(900_000, 1_000 * (2 ** Math.max(0, retryCount - 1)));
    const retryAfter = retryAllowed ? new Date(Date.now() + backoffMs).toISOString() : null;
    const changedAt = new Date().toISOString();
    const suffix = (await digest(`${scope}:${key}`)).slice(0, 12);
    const eventId = `evt_task_failed_${suffix}`;
    const actor = input.actor ?? "Workspace worker";
    const body = {
      ok: true,
      action: input.action,
      replayed: false,
      task: { id: current.id, status: "failed", retryable: retryAllowed, retryCount, retryAfter, maxAttempts: current.max_attempts },
      eventId,
    };
    const results = await database.batch([
      database.prepare(
        `UPDATE tasks SET status = 'failed', cancellation_reason = ?, retry_count = ?, retry_after = ?,
           last_transition_key = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND status NOT IN ('completed', 'cancelled')`,
      ).bind(input.reason, retryCount, retryAfter, key, changedAt, current.id, workspaceId),
      database.prepare(
        `INSERT OR IGNORE INTO task_events (event_id, workspace_id, task_id, type, actor, summary, payload_json, created_at)
         VALUES (?, ?, ?, 'task.failed', ?, ?, ?, ?)`,
      ).bind(eventId, workspaceId, current.id, actor, `Task failed: ${current.title}`, JSON.stringify({ reason: input.reason, retryable: retryAllowed, retryAfter, retryCount }), changedAt),
      database.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").bind(changedAt, workspaceId),
      completedIdempotencyStatement(database, scope, key, ownerToken, 200, body),
    ]);
    if (changed(results[0]) !== 1) throw new ApiError(409, "task_state_conflict", "Task state changed before failure was recorded.");
    return { status: 200, body };
  }

  if (input.action === "claim" || input.action === "heartbeat" || input.action === "release") {
    const current = await database
      .prepare("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?")
      .bind(input.taskId, workspaceId)
      .first<TaskRow>();
    if (!current) throw new ApiError(404, "task_not_found", "Task not found.");
    const now = Date.now();
    const activeLease = current.lease_owner && current.lease_expires_at && Date.parse(current.lease_expires_at) > now;
    const actor = input.actor ?? input.workerId;
    if (input.action === "claim") {
      if (["completed", "cancelled"].includes(current.status)) throw new ApiError(409, "task_terminal", "A completed or cancelled task cannot be claimed.");
      if (current.attempt_count >= current.max_attempts) throw new ApiError(409, "task_retry_exhausted", "Task retry limit has been reached.");
      if (current.retry_after && Date.parse(current.retry_after) > now) throw new ApiError(409, "task_retry_backoff", "Task is waiting for its retry backoff window.");
      const pendingDependency = await database.prepare(
        `SELECT dependency.id FROM task_dependencies d JOIN tasks dependency ON dependency.id = d.depends_on_task_id
         WHERE d.workspace_id = ? AND d.task_id = ? AND dependency.status NOT IN ('completed') LIMIT 1`,
      ).bind(workspaceId, current.id).first<{ id: string }>();
      if (pendingDependency) throw new ApiError(409, "task_dependencies_pending", `Task depends on incomplete task ${pendingDependency.id}.`);
      if (activeLease && current.lease_owner !== input.workerId) throw new ApiError(409, "task_lease_conflict", "Task is leased by another worker.");
      const changedAt = new Date().toISOString();
      const leaseExpiresAt = new Date(now + input.leaseMinutes * 60_000).toISOString();
      const suffix = (await digest(`${scope}:${key}`)).slice(0, 12);
      const eventId = `evt_task_claimed_${suffix}`;
      const body = {
        ok: true,
        action: input.action,
        replayed: false,
        task: { id: current.id, status: current.status === "failed" ? "planning" : current.status, leaseOwner: input.workerId, leaseExpiresAt, attemptCount: current.attempt_count + 1 },
        eventId,
      };
      const results = await database.batch([
        database.prepare(
          `UPDATE tasks SET status = CASE WHEN status = 'failed' THEN 'planning' ELSE status END,
             lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1,
             retry_after = NULL, last_transition_key = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND workspace_id = ?
             AND (lease_owner IS NULL OR lease_expires_at IS NULL OR datetime(lease_expires_at) <= datetime('now') OR lease_owner = ?)`
        ).bind(input.workerId, leaseExpiresAt, key, changedAt, current.id, workspaceId, input.workerId),
        database.prepare(
          `INSERT OR IGNORE INTO task_events (event_id, workspace_id, task_id, type, actor, summary, payload_json, created_at)
           VALUES (?, ?, ?, 'task.claimed', ?, ?, ?, ?)`
        ).bind(eventId, workspaceId, current.id, actor, `Task claimed by ${input.workerId}`, JSON.stringify({ leaseExpiresAt, attemptCount: current.attempt_count + 1 }), changedAt),
        completedIdempotencyStatement(database, scope, key, ownerToken, 200, body),
      ]);
      if (changed(results[0]) !== 1) throw new ApiError(409, "task_lease_conflict", "Task lease could not be acquired.");
      return { status: 200, body };
    }

    if (!activeLease || current.lease_owner !== input.workerId) throw new ApiError(409, "task_lease_expired", "The task lease is missing or expired.");
    const changedAt = new Date().toISOString();
    const suffix = (await digest(`${scope}:${key}`)).slice(0, 12);
    const eventId = `evt_task_${input.action}_${suffix}`;
    const leaseExpiresAt = input.action === "heartbeat" ? new Date(now + input.leaseMinutes * 60_000).toISOString() : null;
    const nextStatus = input.action === "release" ? "planning" : current.status;
    const body = {
      ok: true,
      action: input.action,
      replayed: false,
      task: { id: current.id, status: nextStatus, leaseOwner: input.action === "release" ? null : input.workerId, leaseExpiresAt, checkpointId: input.action === "heartbeat" ? (input.checkpointId ?? current.checkpoint_id) : current.checkpoint_id },
      eventId,
    };
    const results = await database.batch([
      database.prepare(
        `UPDATE tasks SET status = ?, lease_owner = ?, lease_expires_at = ?, checkpoint_id = ?,
           last_transition_key = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND lease_owner = ? AND datetime(lease_expires_at) > datetime('now')`
      ).bind(nextStatus, input.action === "release" ? null : input.workerId, leaseExpiresAt, input.action === "heartbeat" ? (input.checkpointId ?? current.checkpoint_id) : current.checkpoint_id, key, changedAt, current.id, workspaceId, input.workerId),
      database.prepare(
        `INSERT OR IGNORE INTO task_events (event_id, workspace_id, task_id, type, actor, summary, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(eventId, workspaceId, current.id, `task.${input.action}`, actor, `Task ${input.action} by ${input.workerId}`, JSON.stringify({ leaseExpiresAt, checkpointId: input.action === "heartbeat" ? (input.checkpointId ?? null) : null }), changedAt),
      completedIdempotencyStatement(database, scope, key, ownerToken, 200, body),
    ]);
    if (changed(results[0]) !== 1) throw new ApiError(409, "task_lease_conflict", "Task lease changed before the update completed.");
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
    question: string;
    engine: string;
    telemetry: AgentTelemetry;
    approvalPayload?: AgentMutationPayload;
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
    engine: options.engine,
    telemetry: options.telemetry,
    createdAt,
  };

  const needsApproval = options.output.needsApproval === true && Boolean(options.taskId);
  const approvalId = needsApproval ? `approval_${suffix}` : undefined;
  const approvalDigest = needsApproval
    ? await digest(canonicalRequest(options.approvalPayload ?? {
        action: options.output.proposedAction ?? "agent.apply",
        workspaceId: options.workspaceId,
        taskId: options.taskId ?? null,
        snapshot: { repository: "unavailable" },
        artifacts: options.output.artifacts ?? [],
        execution: options.output.execution ?? null,
        executions: options.output.executions ?? [],
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
        `INSERT OR IGNORE INTO agent_run_audit
          (run_id, workspace_id, question, answer, engine, duration_ms,
           token_usage_json, tools_json, audit_log_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        runId,
        options.workspaceId,
        options.question,
        summary,
        options.engine,
        options.telemetry.durationMs,
        JSON.stringify(options.telemetry.tokenUsage),
        JSON.stringify(options.telemetry.tools),
        JSON.stringify(options.telemetry.auditLog),
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
            contractVersion: options.approvalPayload ? 2 : 1,
            approvalPayload: options.approvalPayload ?? null,
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
