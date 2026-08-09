import { ApiError } from "./api-contract.ts";
import {
  mcpPolicyDecisionSchema,
  mcpToolDescriptorSchema,
  mcpToolRiskSchema,
  type McpPolicyDecision,
  type McpPolicyMutation,
  type McpToolDescriptor,
  type McpToolRisk,
} from "./mcp-contract.ts";

type PolicyRow = {
  workspace_id: string;
  scope_type: string;
  scope_id: string;
  server_id: string;
  tool_name: string;
  decision: string;
  risk: string;
  requires_approval: number;
  revision: number;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

type PolicyEventRow = {
  sequence: number;
  event_id: string;
  workspace_id: string;
  idempotency_key: string;
  request_digest: string;
  scope_type: string;
  scope_id: string;
  server_id: string;
  tool_name: string;
  risk: string;
  previous_decision: string;
  decision: string;
  previous_revision: number;
  revision: number;
  actor_id: string;
  created_at: string;
};

type PolicyServerRow = {
  server_id: string;
  status: string;
  enabled: number;
  revision: number;
  tools_json: string;
};

export type McpStoredPolicy = {
  workspaceId: string;
  scopeType: "workspace" | "agent";
  scopeId: string;
  serverId: string;
  toolName: string;
  decision: McpPolicyDecision;
  risk: McpToolRisk;
  requiresApproval: boolean;
  revision: number;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type McpEffectivePolicy = {
  serverId: string;
  toolName: string;
  title?: string;
  description?: string;
  risk: McpToolRisk;
  requiresApproval: boolean;
  workspaceDecision: McpPolicyDecision;
  agentDecision: McpPolicyDecision;
  effectiveDecision: "allow" | "deny";
  reason:
    | "workspace_allowed"
    | "workspace_default_deny"
    | "workspace_denied"
    | "agent_denied";
};

function safeDecision(value: string | null | undefined): McpPolicyDecision {
  const parsed = mcpPolicyDecisionSchema.safeParse(value);
  return parsed.success ? parsed.data : "inherit";
}

function safeRisk(value: string): McpToolRisk {
  const parsed = mcpToolRiskSchema.safeParse(value);
  return parsed.success ? parsed.data : "external";
}

function parseTools(value: string): McpToolDescriptor[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((tool) => {
      const result = mcpToolDescriptorSchema.safeParse(tool);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

function mapPolicy(row: PolicyRow): McpStoredPolicy {
  return {
    workspaceId: row.workspace_id,
    scopeType: row.scope_type === "agent" ? "agent" : "workspace",
    scopeId: row.scope_id,
    serverId: row.server_id,
    toolName: row.tool_name,
    decision: safeDecision(row.decision),
    risk: safeRisk(row.risk),
    requiresApproval: row.requires_approval === 1,
    revision: row.revision,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: PolicyEventRow) {
  return {
    sequence: row.sequence,
    id: row.event_id,
    workspaceId: row.workspace_id,
    scopeType: row.scope_type === "agent" ? "agent" as const : "workspace" as const,
    scopeId: row.scope_id,
    serverId: row.server_id,
    toolName: row.tool_name,
    risk: safeRisk(row.risk),
    previousDecision: safeDecision(row.previous_decision),
    decision: safeDecision(row.decision),
    previousRevision: row.previous_revision,
    revision: row.revision,
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}

export function evaluateMcpPolicy(
  workspaceDecision: McpPolicyDecision | undefined,
  agentDecision: McpPolicyDecision | undefined,
): Pick<McpEffectivePolicy, "effectiveDecision" | "reason"> {
  const workspace = workspaceDecision ?? "inherit";
  const agent = agentDecision ?? "inherit";
  if (workspace === "deny") {
    return { effectiveDecision: "deny", reason: "workspace_denied" };
  }
  if (workspace !== "allow") {
    return { effectiveDecision: "deny", reason: "workspace_default_deny" };
  }
  if (agent === "deny") {
    return { effectiveDecision: "deny", reason: "agent_denied" };
  }
  return { effectiveDecision: "allow", reason: "workspace_allowed" };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

async function requestDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function policyKey(scopeType: "workspace" | "agent", scopeId: string, serverId: string, toolName: string) {
  return `${scopeType}\u0000${scopeId}\u0000${serverId}\u0000${toolName}`;
}

async function loadPolicyRevision(database: D1Database, workspaceId: string): Promise<number> {
  const row = await database
    .prepare("SELECT revision FROM mcp_policy_state WHERE workspace_id = ? LIMIT 1")
    .bind(workspaceId)
    .first<{ revision: number }>();
  return row?.revision ?? 0;
}

export async function listMcpPolicySnapshot(args: {
  database: D1Database;
  workspaceId: string;
  agentId?: string;
  eventLimit?: number;
}) {
  const eventLimit = Math.min(Math.max(Math.trunc(args.eventLimit ?? 100), 1), 100);
  const [revision, policyResult, serverResult, eventResult] = await Promise.all([
    loadPolicyRevision(args.database, args.workspaceId),
    args.database
      .prepare(
        `SELECT * FROM mcp_tool_policies
         WHERE workspace_id = ? ORDER BY server_id, tool_name, scope_type, scope_id`,
      )
      .bind(args.workspaceId)
      .all<PolicyRow>(),
    args.database
      .prepare(
        `SELECT server_id, status, enabled, revision, tools_json FROM mcp_servers
         WHERE workspace_id = ? ORDER BY server_id`,
      )
      .bind(args.workspaceId)
      .all<PolicyServerRow>(),
    args.database
      .prepare(
        `SELECT * FROM mcp_policy_events
         WHERE workspace_id = ? ORDER BY sequence DESC LIMIT ?`,
      )
      .bind(args.workspaceId, eventLimit)
      .all<PolicyEventRow>(),
  ]);
  const policies = policyResult.results.map(mapPolicy);
  const byKey = new Map(
    policies.map((policy) => [
      policyKey(policy.scopeType, policy.scopeId, policy.serverId, policy.toolName),
      policy,
    ]),
  );
  const effective = serverResult.results.flatMap((server) =>
    parseTools(server.tools_json).map((tool): McpEffectivePolicy => {
      const workspaceDecision = byKey.get(
        policyKey("workspace", args.workspaceId, server.server_id, tool.name),
      )?.decision ?? "inherit";
      const agentDecision = args.agentId
        ? byKey.get(policyKey("agent", args.agentId, server.server_id, tool.name))?.decision ?? "inherit"
        : "inherit";
      return {
        serverId: server.server_id,
        toolName: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        risk: tool.risk,
        requiresApproval: tool.risk !== "read" || tool.requiresApproval,
        workspaceDecision,
        agentDecision,
        ...evaluateMcpPolicy(workspaceDecision, agentDecision),
      };
    }),
  );
  return {
    workspaceId: args.workspaceId,
    revision,
    ...(args.agentId ? { agentId: args.agentId } : {}),
    policies,
    effective,
    events: eventResult.results.map(mapEvent),
  };
}

async function findDescriptor(
  database: D1Database,
  workspaceId: string,
  serverId: string,
  toolName: string,
): Promise<McpToolDescriptor> {
  const row = await database
    .prepare("SELECT tools_json FROM mcp_servers WHERE workspace_id = ? AND server_id = ? LIMIT 1")
    .bind(workspaceId, serverId)
    .first<{ tools_json: string }>();
  if (!row) throw new ApiError(404, "mcp_server_not_found", "The MCP server is not registered in this workspace.");
  const descriptor = parseTools(row.tools_json).find((tool) => tool.name === toolName);
  if (!descriptor) throw new ApiError(404, "mcp_tool_not_found", "The MCP tool is not in the server-side capability catalog.");
  return descriptor;
}

async function loadStoredPolicy(args: {
  database: D1Database;
  workspaceId: string;
  scopeType: "workspace" | "agent";
  scopeId: string;
  serverId: string;
  toolName: string;
}): Promise<PolicyRow | null> {
  return args.database
    .prepare(
      `SELECT * FROM mcp_tool_policies
       WHERE workspace_id = ? AND scope_type = ? AND scope_id = ?
         AND server_id = ? AND tool_name = ? LIMIT 1`,
    )
    .bind(args.workspaceId, args.scopeType, args.scopeId, args.serverId, args.toolName)
    .first<PolicyRow>();
}

export async function mutateMcpPolicy(args: {
  database: D1Database;
  workspaceId: string;
  input: McpPolicyMutation;
  idempotencyKey: string;
  actorId: string;
}) {
  const scopeType = args.input.scope.type;
  const scopeId = scopeType === "workspace" ? args.workspaceId : args.input.scope.agentId;
  const digest = await requestDigest({
    workspaceId: args.workspaceId,
    expectedRevision: args.input.expectedRevision,
    scopeType,
    scopeId,
    serverId: args.input.serverId,
    toolName: args.input.toolName,
    decision: args.input.decision,
  });
  const replay = await args.database
    .prepare(
      "SELECT * FROM mcp_policy_events WHERE workspace_id = ? AND idempotency_key = ? LIMIT 1",
    )
    .bind(args.workspaceId, args.idempotencyKey)
    .first<PolicyEventRow>();
  if (replay) {
    if (replay.request_digest !== digest) {
      throw new ApiError(409, "idempotency_conflict", "The idempotency key is already bound to another MCP policy mutation.");
    }
    return {
      replayed: true,
      ...(await listMcpPolicySnapshot({
        database: args.database,
        workspaceId: args.workspaceId,
        ...(scopeType === "agent" ? { agentId: scopeId } : {}),
      })),
    };
  }

  const workspace = await args.database
    .prepare("SELECT id FROM workspaces WHERE id = ? LIMIT 1")
    .bind(args.workspaceId)
    .first<{ id: string }>();
  if (!workspace) throw new ApiError(404, "workspace_not_found", "The workspace was not found.");
  const descriptor = await findDescriptor(
    args.database,
    args.workspaceId,
    args.input.serverId,
    args.input.toolName,
  );
  const now = new Date().toISOString();
  await args.database
    .prepare(
      `INSERT OR IGNORE INTO mcp_policy_state (workspace_id, revision, updated_at)
       VALUES (?, 0, ?)`,
    )
    .bind(args.workspaceId, now)
    .run();
  const currentRevision = await loadPolicyRevision(args.database, args.workspaceId);
  if (currentRevision !== args.input.expectedRevision) {
    throw new ApiError(409, "mcp_policy_revision_conflict", "The MCP policy changed. Refresh before applying another decision.", {
      expectedRevision: args.input.expectedRevision,
      currentRevision,
    });
  }

  if (scopeType === "agent" && args.input.decision === "allow") {
    const workspacePolicy = await loadStoredPolicy({
      database: args.database,
      workspaceId: args.workspaceId,
      scopeType: "workspace",
      scopeId: args.workspaceId,
      serverId: args.input.serverId,
      toolName: args.input.toolName,
    });
    if (safeDecision(workspacePolicy?.decision) !== "allow") {
      throw new ApiError(409, "mcp_agent_scope_expansion", "An agent policy cannot allow a tool that the workspace has not allowed.");
    }
  }

  const previous = await loadStoredPolicy({
    database: args.database,
    workspaceId: args.workspaceId,
    scopeType,
    scopeId,
    serverId: args.input.serverId,
    toolName: args.input.toolName,
  });
  const previousDecision = safeDecision(previous?.decision);
  const nextRevision = currentRevision + 1;
  const eventId = `mcpp_${crypto.randomUUID()}`;
  const requiresApproval = descriptor.risk !== "read" || descriptor.requiresApproval;

  try {
    const results = await args.database.batch([
      args.database
        .prepare(
          `INSERT INTO mcp_policy_events
            (event_id, workspace_id, idempotency_key, request_digest, scope_type,
             scope_id, server_id, tool_name, risk, previous_decision, decision,
             previous_revision, revision, actor_id, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM mcp_policy_state
           WHERE workspace_id = ? AND revision = ?`,
        )
        .bind(
          eventId,
          args.workspaceId,
          args.idempotencyKey,
          digest,
          scopeType,
          scopeId,
          args.input.serverId,
          args.input.toolName,
          descriptor.risk,
          previousDecision,
          args.input.decision,
          currentRevision,
          nextRevision,
          args.actorId,
          now,
          args.workspaceId,
          currentRevision,
        ),
      args.database
        .prepare(
          `INSERT INTO mcp_tool_policies
            (workspace_id, scope_type, scope_id, server_id, tool_name, decision,
             risk, requires_approval, revision, updated_by, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM mcp_policy_events WHERE event_id = ?
           ON CONFLICT(workspace_id, scope_type, scope_id, server_id, tool_name)
           DO UPDATE SET decision = excluded.decision, risk = excluded.risk,
             requires_approval = excluded.requires_approval,
             revision = excluded.revision, updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        )
        .bind(
          args.workspaceId,
          scopeType,
          scopeId,
          args.input.serverId,
          args.input.toolName,
          args.input.decision,
          descriptor.risk,
          requiresApproval ? 1 : 0,
          nextRevision,
          args.actorId,
          previous?.created_at ?? now,
          now,
          eventId,
        ),
      args.database
        .prepare(
          `UPDATE mcp_policy_state SET revision = ?, updated_at = ?
           WHERE workspace_id = ? AND revision = ?
             AND EXISTS (SELECT 1 FROM mcp_policy_events WHERE event_id = ?)`,
        )
        .bind(nextRevision, now, args.workspaceId, currentRevision, eventId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1 || (results[2]?.meta.changes ?? 0) !== 1) {
      throw new ApiError(409, "mcp_policy_revision_conflict", "The MCP policy changed during this update. Refresh and retry.");
    }
  } catch (error) {
    const racedReplay = await args.database
      .prepare(
        "SELECT * FROM mcp_policy_events WHERE workspace_id = ? AND idempotency_key = ? LIMIT 1",
      )
      .bind(args.workspaceId, args.idempotencyKey)
      .first<PolicyEventRow>()
      .catch(() => null);
    if (racedReplay?.request_digest === digest) {
      return {
        replayed: true,
        ...(await listMcpPolicySnapshot({
          database: args.database,
          workspaceId: args.workspaceId,
          ...(scopeType === "agent" ? { agentId: scopeId } : {}),
        })),
      };
    }
    if (error instanceof ApiError) throw error;
    if (racedReplay) {
      throw new ApiError(409, "idempotency_conflict", "The idempotency key is already bound to another MCP policy mutation.");
    }
    throw error;
  }

  const snapshot = await listMcpPolicySnapshot({
    database: args.database,
    workspaceId: args.workspaceId,
    ...(scopeType === "agent" ? { agentId: scopeId } : {}),
  });
  return {
    replayed: false,
    ...snapshot,
    policy: snapshot.policies.find(
      (policy) =>
        policy.scopeType === scopeType &&
        policy.scopeId === scopeId &&
        policy.serverId === args.input.serverId &&
        policy.toolName === args.input.toolName,
    ),
  };
}

export async function authorizeMcpToolInvocation(args: {
  database: D1Database;
  workspaceId: string;
  agentId: string;
  serverId: string;
  toolName: string;
  expectedServerRevision: number;
  expectedPolicyRevision: number;
}): Promise<McpToolDescriptor> {
  const [server, revision, workspacePolicy, agentPolicy] = await Promise.all([
    args.database
      .prepare(
        `SELECT server_id, status, enabled, revision, tools_json FROM mcp_servers
         WHERE workspace_id = ? AND server_id = ? LIMIT 1`,
      )
      .bind(args.workspaceId, args.serverId)
      .first<PolicyServerRow>(),
    loadPolicyRevision(args.database, args.workspaceId),
    loadStoredPolicy({
      database: args.database,
      workspaceId: args.workspaceId,
      scopeType: "workspace",
      scopeId: args.workspaceId,
      serverId: args.serverId,
      toolName: args.toolName,
    }),
    loadStoredPolicy({
      database: args.database,
      workspaceId: args.workspaceId,
      scopeType: "agent",
      scopeId: args.agentId,
      serverId: args.serverId,
      toolName: args.toolName,
    }),
  ]);
  if (!server || server.status !== "connected" || server.enabled !== 1) {
    throw new ApiError(403, "mcp_server_disabled", "The MCP server was disconnected or revoked before tool invocation.");
  }
  if (server.revision !== args.expectedServerRevision) {
    throw new ApiError(409, "mcp_server_revision_stale", "The MCP server changed after tool discovery. Refresh before invoking it.");
  }
  if (revision !== args.expectedPolicyRevision) {
    throw new ApiError(409, "mcp_policy_revision_stale", "The MCP policy changed after tool discovery. Refresh before invoking it.");
  }
  const descriptor = parseTools(server.tools_json).find((tool) => tool.name === args.toolName);
  if (!descriptor) throw new ApiError(403, "mcp_tool_revoked", "The MCP tool is no longer present in the server-side catalog.");
  const effective = evaluateMcpPolicy(
    safeDecision(workspacePolicy?.decision),
    safeDecision(agentPolicy?.decision),
  );
  if (effective.effectiveDecision !== "allow") {
    throw new ApiError(403, "mcp_tool_denied", "The current workspace or agent policy denies this MCP tool.");
  }
  if (descriptor.risk !== "read" || descriptor.requiresApproval) {
    throw new ApiError(403, "mcp_tool_approval_required", "Side-effecting MCP tools require a payload-bound approval bridge and remain disabled.");
  }
  return descriptor;
}

export async function invokePolicyCheckedMcpTool<T>(args: {
  authorize: () => Promise<unknown>;
  transport: () => Promise<T>;
}): Promise<T> {
  // Authorization deliberately happens inside the invocation wrapper so a
  // cached list-time decision can never be treated as execution permission.
  await args.authorize();
  return args.transport();
}
