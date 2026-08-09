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
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    attemptCount: integer("attempt_count").notNull().default(0),
    checkpointId: text("checkpoint_id"),
    maxAttempts: integer("max_attempts").notNull().default(3),
    retryCount: integer("retry_count").notNull().default(0),
    retryAfter: text("retry_after"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("tasks_workspace_status_idx").on(table.workspaceId, table.status),
    index("tasks_workspace_lease_idx").on(table.workspaceId, table.leaseExpiresAt),
    uniqueIndex("tasks_workspace_creation_key_idx").on(
      table.workspaceId,
      table.createdByIdempotencyKey,
    ),
  ],
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    taskId: text("task_id").notNull().references(() => tasks.id),
    dependsOnTaskId: text("depends_on_task_id").notNull().references(() => tasks.id),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.taskId, table.dependsOnTaskId] }),
    index("task_dependencies_lookup_idx").on(table.workspaceId, table.taskId),
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

export const agentRunAudit = sqliteTable(
  "agent_run_audit",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => agentRuns.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    engine: text("engine").notNull(),
    durationMs: integer("duration_ms").notNull(),
    tokenUsageJson: text("token_usage_json").notNull().default("{}"),
    toolsJson: text("tools_json").notNull().default("[]"),
    auditLogJson: text("audit_log_json").notNull().default("[]"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("agent_run_audit_workspace_idx").on(table.workspaceId, table.createdAt),
  ],
);

export const handoffs = sqliteTable(
  "handoffs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    taskId: text("task_id").notNull().references(() => tasks.id),
    fromRole: text("from_role").notNull(),
    toRole: text("to_role").notNull(),
    submittedBy: text("submitted_by").notNull(),
    status: text("status").notNull().default("pending"),
    contextJson: text("context_json").notNull(),
    evidenceJson: text("evidence_json").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    createdAt: text("created_at").notNull(),
    acceptedBy: text("accepted_by"),
    acceptedAt: text("accepted_at"),
    publishedBy: text("published_by"),
    publishedAt: text("published_at"),
    updatedAt: text("updated_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    index("handoffs_workspace_task_idx").on(table.workspaceId, table.taskId, table.createdAt),
    index("handoffs_status_idx").on(table.workspaceId, table.status),
  ],
);

export const handoffReviews = sqliteTable(
  "handoff_reviews",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    handoffId: text("handoff_id").notNull().references(() => handoffs.id),
    reviewerId: text("reviewer_id").notNull(),
    decision: text("decision").notNull(),
    notes: text("notes").notNull().default(""),
    evidenceDigest: text("evidence_digest").notNull(),
    humanApproved: integer("human_approved").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("handoff_reviews_handoff_idx").on(table.handoffId, table.createdAt)],
);

export const mcpServers = sqliteTable(
  "mcp_servers",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    serverId: text("server_id").notNull(),
    allowlistId: text("allowlist_id").notNull(),
    label: text("label").notNull(),
    status: text("status").notNull().default("registered"),
    enabled: integer("enabled").notNull().default(0),
    capabilitiesJson: text("capabilities_json").notNull().default("{}"),
    toolsJson: text("tools_json").notNull().default("[]"),
    revision: integer("revision").notNull().default(1),
    lastErrorCode: text("last_error_code"),
    lastCheckedAt: text("last_checked_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.serverId] }),
    index("mcp_servers_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.enabled,
    ),
  ],
);

// Lifecycle history is append-only. Runtime initialization and the matching
// migration install triggers that reject UPDATE and DELETE operations.
export const mcpRegistryEvents = sqliteTable(
  "mcp_registry_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    serverId: text("server_id").notNull(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    detailCode: text("detail_code"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("mcp_registry_events_event_id_idx").on(table.eventId),
    index("mcp_registry_events_workspace_idx").on(
      table.workspaceId,
      table.sequence,
    ),
  ],
);

export const mcpPolicyState = sqliteTable("mcp_policy_state", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id),
  revision: integer("revision").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

export const mcpToolPolicies = sqliteTable(
  "mcp_tool_policies",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    serverId: text("server_id").notNull(),
    toolName: text("tool_name").notNull(),
    decision: text("decision").notNull().default("inherit"),
    risk: text("risk").notNull(),
    requiresApproval: integer("requires_approval").notNull().default(0),
    revision: integer("revision").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.workspaceId,
        table.scopeType,
        table.scopeId,
        table.serverId,
        table.toolName,
      ],
    }),
    index("mcp_tool_policies_workspace_idx").on(
      table.workspaceId,
      table.serverId,
      table.toolName,
    ),
  ],
);

// Mutation history is append-only and intentionally excludes tool arguments,
// credentials, and authorization headers.
export const mcpPolicyEvents = sqliteTable(
  "mcp_policy_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id").notNull(),
    serverId: text("server_id").notNull(),
    toolName: text("tool_name").notNull(),
    risk: text("risk").notNull(),
    previousDecision: text("previous_decision").notNull(),
    decision: text("decision").notNull(),
    previousRevision: integer("previous_revision").notNull(),
    revision: integer("revision").notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("mcp_policy_events_event_id_idx").on(table.eventId),
    uniqueIndex("mcp_policy_events_idempotency_idx").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    uniqueIndex("mcp_policy_events_revision_idx").on(
      table.workspaceId,
      table.revision,
    ),
    index("mcp_policy_events_workspace_idx").on(table.workspaceId, table.sequence),
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

export const automationProfiles = sqliteTable("automation_profiles", {
  id: text("id").notNull(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  ownerId: text("owner_id").notNull(),
  kind: text("kind").notNull(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  definitionJson: text("definition_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.ownerId, table.kind, table.id, table.version] })]);

export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  enabled: integer("enabled").notNull().default(1),
  triggerJson: text("trigger_json").notNull(),
  agentProfileId: text("agent_profile_id").notNull(),
  agentProfileVersion: integer("agent_profile_version").notNull(),
  skillProfileId: text("skill_profile_id").notNull(),
  skillProfileVersion: integer("skill_profile_version").notNull(),
  nextRunAt: text("next_run_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("automations_due_idx").on(table.workspaceId, table.ownerId, table.enabled, table.nextRunAt)]);

export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  automationId: text("automation_id").notNull().references(() => automations.id),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  ownerId: text("owner_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull(),
  snapshotId: text("snapshot_id").notNull(),
  taskId: text("task_id"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: text("lease_expires_at"),
  retryCount: integer("retry_count").notNull().default(0),
  cancelRequested: integer("cancel_requested").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [uniqueIndex("automation_runs_idempotency_idx").on(table.automationId, table.idempotencyKey), index("automation_runs_queue_idx").on(table.workspaceId, table.ownerId, table.status, table.leaseExpiresAt)]);

export const automationEvents = sqliteTable("automation_events", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull(),
  runId: text("run_id").notNull().references(() => automationRuns.id),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  type: text("type").notNull(),
  actorId: text("actor_id").notNull(),
  detailJson: text("detail_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("automation_events_id_idx").on(table.eventId), index("automation_events_run_idx").on(table.runId, table.sequence)]);

export const automationSnapshots = sqliteTable("automation_snapshots", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => automationRuns.id),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  manifestJson: text("manifest_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [uniqueIndex("automation_snapshots_run_idx").on(table.runId)]);

export const operationsQuota = sqliteTable("operations_quota", {
  workspaceId: text("workspace_id").notNull(),
  bucket: text("bucket").notNull(),
  windowStart: text("window_start").notNull(),
  used: integer("used").notNull().default(0),
}, (table) => [primaryKey({ columns: [table.workspaceId, table.bucket, table.windowStart] })]);

export const operationsAudit = sqliteTable("operations_audit", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  actorId: text("actor_id").notNull(),
  eventType: text("event_type").notNull(),
  traceId: text("trace_id").notNull(),
  detailJson: text("detail_json").notNull(),
  createdAt: text("created_at").notNull(),
});
