import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repositoryName: text("repository_name").notNull(),
  repositoryPath: text("repository_path").notNull(),
  provider: text("provider").notNull().default("github"),
  defaultBranch: text("default_branch").notNull().default("main"),
  activeBranch: text("active_branch").notNull(),
  baseSha: text("base_sha").notNull(),
  headSha: text("head_sha").notNull(),
  status: text("status").notNull().default("ready"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    status: text("status").notNull(),
    riskLevel: text("risk_level").notNull().default("R1"),
    branch: text("branch").notNull(),
    baseSha: text("base_sha").notNull(),
    actor: text("actor").notNull().default("Human + Agent"),
    progress: integer("progress").notNull().default(0),
    model: text("model"),
    createdByIdempotencyKey: text("created_by_idempotency_key").notNull(),
    lastTransitionKey: text("last_transition_key"),
    cancellationReason: text("cancellation_reason"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("tasks_workspace_status_idx").on(table.workspaceId, table.status),
    uniqueIndex("tasks_workspace_creation_key_idx").on(
      table.workspaceId,
      table.createdByIdempotencyKey,
    ),
  ],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    action: text("action").notNull(),
    summary: text("summary").notNull(),
    riskLevel: text("risk_level").notNull(),
    status: text("status").notNull().default("pending"),
    detailsJson: text("details_json").notNull().default("{}"),
    actionDigest: text("action_digest").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
    decisionEventId: text("decision_event_id"),
    decisionIdempotencyKey: text("decision_idempotency_key"),
    decidedAt: text("decided_at"),
  },
  (table) => [
    index("approvals_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
    index("approvals_task_idx").on(table.taskId),
  ],
);

// This table is append-only. D1 initialization installs triggers that reject
// UPDATE and DELETE so the invariant is enforced below the application layer.
export const taskEvents = sqliteTable(
  "task_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    taskId: text("task_id").references(() => tasks.id),
    type: text("type").notNull(),
    actor: text("actor").notNull(),
    summary: text("summary").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("task_events_event_id_idx").on(table.eventId),
    index("task_events_workspace_sequence_idx").on(
      table.workspaceId,
      table.sequence,
    ),
    index("task_events_task_sequence_idx").on(table.taskId, table.sequence),
  ],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    taskId: text("task_id").references(() => tasks.id),
    idempotencyKey: text("idempotency_key").notNull(),
    mode: text("mode").notNull(),
    model: text("model").notNull(),
    promptHash: text("prompt_hash").notNull(),
    outputJson: text("output_json").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("agent_runs_workspace_idempotency_idx").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    index("agent_runs_task_idx").on(table.taskId),
  ],
);

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull(),
    ownerToken: text("owner_token").notNull(),
    responseStatus: integer("response_status"),
    responseJson: text("response_json"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [primaryKey({ columns: [table.scope, table.key] })],
);
