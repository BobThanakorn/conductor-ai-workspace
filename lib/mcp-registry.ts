import { ApiError } from "./api-contract.ts";
import {
  mcpServerStatusSchema,
  mcpToolDescriptorSchema,
  type McpAllowlistEntry,
  type McpRegistryServer,
  type McpRuntimeServer,
  type McpServerAction,
  type McpServerStatus,
} from "./mcp-contract.ts";
import { discoverMcpServer, normalizeTrustedMcpUrl, type McpDiscoveryResult } from "./mcp-gateway.ts";
import { listMcpPolicySnapshot } from "./mcp-policy.ts";

export type McpRegistryBindings = {
  MCP_GATEWAY_URL?: string;
  MCP_SERVER_ALLOWLIST?: string;
  MCP_ADMIN_TOKEN?: string;
  [key: string]: unknown;
};

type McpServerRow = {
  workspace_id: string;
  server_id: string;
  allowlist_id: string;
  label: string;
  status: string;
  enabled: number;
  capabilities_json: string;
  tools_json: string;
  revision: number;
  last_error_code: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
};

type McpRegistryEventRow = {
  sequence: number;
  event_id: string;
  workspace_id: string;
  server_id: string;
  type: string;
  status: string;
  detail_code: string | null;
  created_at: string;
};

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function configured(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertAllowlistEntry(value: unknown): McpAllowlistEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Each MCP allowlist entry must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const id = configured(raw.id);
  const label = configured(raw.label);
  const url = configured(raw.url);
  const secretRef = configured(raw.secretRef);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) {
    throw new Error("MCP allowlist IDs must be safe identifiers.");
  }
  if (!label || label.length > 160 || !url) {
    throw new Error("MCP allowlist entries require a label and URL.");
  }
  if (secretRef && !/^[A-Z][A-Z0-9_]{2,127}$/.test(secretRef)) {
    throw new Error("MCP secretRef must name a server-side environment binding.");
  }
  return {
    id,
    label,
    url: normalizeTrustedMcpUrl(url),
    transport: "streamable-http",
    ...(secretRef ? { secretRef } : {}),
  };
}

export function resolveMcpAllowlist(bindings: McpRegistryBindings): McpAllowlistEntry[] {
  const rawAllowlist = configured(bindings.MCP_SERVER_ALLOWLIST);
  let entries: McpAllowlistEntry[] = [];
  if (rawAllowlist) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawAllowlist);
    } catch {
      throw new Error("MCP_SERVER_ALLOWLIST must be valid JSON.");
    }
    if (!Array.isArray(parsed) || parsed.length > 32) {
      throw new Error("MCP_SERVER_ALLOWLIST must be an array of at most 32 servers.");
    }
    entries = parsed.map(assertAllowlistEntry);
  } else {
    const gatewayUrl = configured(bindings.MCP_GATEWAY_URL);
    if (gatewayUrl) {
      entries = [
        assertAllowlistEntry({
          id: "docker-mcp-gateway",
          label: "Docker MCP Gateway",
          url: gatewayUrl,
          ...(configured(bindings.MCP_GATEWAY_AUTH_TOKEN)
            ? { secretRef: "MCP_GATEWAY_AUTH_TOKEN" }
            : {}),
        }),
      ];
    }
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`Duplicate MCP allowlist ID: ${entry.id}`);
    seen.add(entry.id);
  }
  return entries;
}

function resolveSecret(bindings: McpRegistryBindings, entry: McpAllowlistEntry): string | undefined {
  if (!entry.secretRef) return undefined;
  const secret = configured(bindings[entry.secretRef]);
  if (!secret) throw new ApiError(503, "mcp_secret_unavailable", "The MCP server credential is not configured.");
  return secret;
}

function mapRow(row: McpServerRow): McpRegistryServer {
  const status = mcpServerStatusSchema.safeParse(row.status);
  const tools = parseJson<unknown[]>(row.tools_json, []).flatMap((tool) => {
    const parsed = mcpToolDescriptorSchema.safeParse(tool);
    return parsed.success ? [parsed.data] : [];
  });
  return {
    workspaceId: row.workspace_id,
    serverId: row.server_id,
    allowlistId: row.allowlist_id,
    label: row.label,
    status: status.success ? status.data : "unavailable",
    enabled: row.enabled === 1 && status.success && status.data === "connected",
    capabilities: parseJson<Record<string, unknown>>(row.capabilities_json, {}),
    tools,
    revision: row.revision,
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    ...(row.last_checked_at ? { lastCheckedAt: row.last_checked_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function appendRegistryEvent(
  database: D1Database,
  input: {
    workspaceId: string;
    serverId: string;
    type: string;
    status: McpServerStatus;
    detailCode?: string;
  },
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO mcp_registry_events
        (event_id, workspace_id, server_id, type, status, detail_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      `mcpe_${crypto.randomUUID()}`,
      input.workspaceId,
      input.serverId,
      input.type,
      input.status,
      input.detailCode ?? null,
      new Date().toISOString(),
    )
    .run();
}

export async function listMcpServers(
  database: D1Database,
  workspaceId: string,
): Promise<McpRegistryServer[]> {
  const result = await database
    .prepare(
      `SELECT * FROM mcp_servers
       WHERE workspace_id = ?
       ORDER BY label ASC, server_id ASC`,
    )
    .bind(workspaceId)
    .all<McpServerRow>();
  return result.results.map(mapRow);
}

export async function listMcpRegistryEvents(
  database: D1Database,
  workspaceId: string,
  limit = 100,
) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const result = await database
    .prepare(
      `SELECT * FROM mcp_registry_events
       WHERE workspace_id = ?
       ORDER BY sequence DESC LIMIT ?`,
    )
    .bind(workspaceId, safeLimit)
    .all<McpRegistryEventRow>();
  return result.results.map((row) => ({
    sequence: row.sequence,
    id: row.event_id,
    workspaceId: row.workspace_id,
    serverId: row.server_id,
    type: row.type,
    status: mcpServerStatusSchema.safeParse(row.status).success ? row.status : "unavailable",
    ...(row.detail_code ? { detailCode: row.detail_code } : {}),
    createdAt: row.created_at,
  }));
}

async function loadMcpServer(
  database: D1Database,
  workspaceId: string,
  serverId: string,
): Promise<McpRegistryServer> {
  const row = await database
    .prepare("SELECT * FROM mcp_servers WHERE workspace_id = ? AND server_id = ? LIMIT 1")
    .bind(workspaceId, serverId)
    .first<McpServerRow>();
  if (!row) throw new ApiError(404, "mcp_server_not_found", "The MCP server is not registered in this workspace.");
  return mapRow(row);
}

export async function registerMcpServer(args: {
  database: D1Database;
  workspaceId: string;
  allowlistId: string;
  bindings: McpRegistryBindings;
}): Promise<McpRegistryServer> {
  const entry = resolveMcpAllowlist(args.bindings).find((item) => item.id === args.allowlistId);
  if (!entry) {
    throw new ApiError(403, "mcp_server_not_allowlisted", "Only administrator-allowlisted MCP servers can be registered.");
  }
  const workspace = await args.database
    .prepare("SELECT id FROM workspaces WHERE id = ? LIMIT 1")
    .bind(args.workspaceId)
    .first<{ id: string }>();
  if (!workspace) throw new ApiError(404, "workspace_not_found", "The workspace was not found.");
  const now = new Date().toISOString();
  await args.database
    .prepare(
      `INSERT INTO mcp_servers
        (workspace_id, server_id, allowlist_id, label, status, enabled,
         capabilities_json, tools_json, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'registered', 0, '{}', '[]', 1, ?, ?)
       ON CONFLICT(workspace_id, server_id) DO UPDATE SET
         allowlist_id = excluded.allowlist_id,
         label = excluded.label,
         status = 'registered',
         enabled = 0,
         revision = mcp_servers.revision + 1,
         last_error_code = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(args.workspaceId, entry.id, entry.id, entry.label, now, now)
    .run();
  await appendRegistryEvent(args.database, {
    workspaceId: args.workspaceId,
    serverId: entry.id,
    type: "mcp.server.registered",
    status: "registered",
  });
  return loadMcpServer(args.database, args.workspaceId, entry.id);
}

async function persistDiscovery(args: {
  database: D1Database;
  workspaceId: string;
  serverId: string;
  discovery: McpDiscoveryResult;
  status: McpServerStatus;
  enabled: boolean;
  eventType: string;
}): Promise<McpRegistryServer> {
  await args.database
    .prepare(
      `UPDATE mcp_servers SET
         status = ?, enabled = ?, capabilities_json = ?, tools_json = ?,
         revision = revision + 1,
         last_error_code = NULL, last_checked_at = ?, updated_at = ?
       WHERE workspace_id = ? AND server_id = ?`,
    )
    .bind(
      args.status,
      args.enabled ? 1 : 0,
      JSON.stringify(args.discovery.capabilities),
      JSON.stringify(args.discovery.tools),
      args.discovery.checkedAt,
      args.discovery.checkedAt,
      args.workspaceId,
      args.serverId,
    )
    .run();
  await appendRegistryEvent(args.database, {
    workspaceId: args.workspaceId,
    serverId: args.serverId,
    type: args.eventType,
    status: args.status,
  });
  return loadMcpServer(args.database, args.workspaceId, args.serverId);
}

async function markUnavailable(args: {
  database: D1Database;
  workspaceId: string;
  serverId: string;
  detailCode: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await args.database
    .prepare(
      `UPDATE mcp_servers SET status = 'unavailable', enabled = 0,
         revision = revision + 1,
         last_error_code = ?, last_checked_at = ?, updated_at = ?
       WHERE workspace_id = ? AND server_id = ?`,
    )
    .bind(args.detailCode, now, now, args.workspaceId, args.serverId)
    .run();
  await appendRegistryEvent(args.database, {
    workspaceId: args.workspaceId,
    serverId: args.serverId,
    type: "mcp.server.unavailable",
    status: "unavailable",
    detailCode: args.detailCode,
  });
}

export async function executeMcpServerAction(args: {
  database: D1Database;
  workspaceId: string;
  action: Exclude<McpServerAction["action"], "register">;
  serverId: string;
  bindings: McpRegistryBindings;
  discover?: typeof discoverMcpServer;
}): Promise<McpRegistryServer> {
  const current = await loadMcpServer(args.database, args.workspaceId, args.serverId);
  const allowlisted = resolveMcpAllowlist(args.bindings).find(
    (entry) => entry.id === current.allowlistId,
  );
  if (!allowlisted) {
    await markUnavailable({
      database: args.database,
      workspaceId: args.workspaceId,
      serverId: args.serverId,
      detailCode: "mcp_allowlist_revoked",
    });
    throw new ApiError(403, "mcp_server_not_allowlisted", "The MCP server is no longer allowlisted.");
  }

  if (args.action === "disconnect" || args.action === "revoke") {
    const status: McpServerStatus = args.action === "revoke" ? "revoked" : "disconnected";
    const now = new Date().toISOString();
    await args.database
      .prepare(
        `UPDATE mcp_servers SET status = ?, enabled = 0,
           revision = revision + 1,
           last_error_code = NULL, updated_at = ?
         WHERE workspace_id = ? AND server_id = ?`,
      )
      .bind(status, now, args.workspaceId, args.serverId)
      .run();
    await appendRegistryEvent(args.database, {
      workspaceId: args.workspaceId,
      serverId: args.serverId,
      type: args.action === "revoke" ? "mcp.server.revoked" : "mcp.server.disconnected",
      status,
    });
    return loadMcpServer(args.database, args.workspaceId, args.serverId);
  }

  if (current.status === "revoked") {
    throw new ApiError(409, "mcp_server_revoked", "Register the allowlisted server again before connecting it.");
  }

  try {
    const discovery = await (args.discover ?? discoverMcpServer)({
      server: allowlisted,
      secret: resolveSecret(args.bindings, allowlisted),
    });
    const shouldEnable = args.action === "connect" ||
      (current.enabled && (args.action === "refresh" || args.action === "check_health"));
    return persistDiscovery({
      database: args.database,
      workspaceId: args.workspaceId,
      serverId: args.serverId,
      discovery,
      status: shouldEnable ? "connected" : "disconnected",
      enabled: shouldEnable,
      eventType: args.action === "connect"
        ? "mcp.server.connected"
        : args.action === "refresh"
          ? "mcp.server.refreshed"
          : "mcp.server.health_checked",
    });
  } catch (error) {
    const detailCode = error instanceof ApiError ? error.code : "mcp_gateway_unavailable";
    await markUnavailable({
      database: args.database,
      workspaceId: args.workspaceId,
      serverId: args.serverId,
      detailCode,
    });
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, detailCode, "The MCP server is unavailable. Its tools remain disabled.");
  }
}

export function materializeMcpRuntime(
  servers: readonly McpRegistryServer[],
  bindings: McpRegistryBindings,
  policy: {
    revision: number;
    effective: ReadonlyArray<{
      serverId: string;
      toolName: string;
      risk: string;
      effectiveDecision: "allow" | "deny";
    }>;
  } = { revision: 0, effective: [] },
): { servers: McpRuntimeServer[]; denied: Array<{ serverId: string; code: string }> } {
  const allowlist = resolveMcpAllowlist(bindings);
  const runtime: McpRuntimeServer[] = [];
  const denied: Array<{ serverId: string; code: string }> = [];
  for (const server of servers) {
    if (!server.enabled || server.status !== "connected") {
      denied.push({ serverId: server.serverId, code: "mcp_server_disabled" });
      continue;
    }
    const entry = allowlist.find((item) => item.id === server.allowlistId);
    if (!entry) {
      denied.push({ serverId: server.serverId, code: "mcp_server_not_allowlisted" });
      continue;
    }
    let secret: string | undefined;
    try {
      secret = resolveSecret(bindings, entry);
    } catch {
      denied.push({ serverId: server.serverId, code: "mcp_secret_unavailable" });
      continue;
    }
    const allowed = new Set(
      policy.effective
        .filter(
          (entry) =>
            entry.serverId === server.serverId &&
            entry.risk === "read" &&
            entry.effectiveDecision === "allow",
        )
        .map((entry) => entry.toolName),
    );
    const readTools = server.tools
      .filter((tool) => tool.risk === "read" && allowed.has(tool.name))
      .map((tool) => ({
        ...tool,
        serverRevision: server.revision,
        policyRevision: policy.revision,
      }));
    if (readTools.length === 0) {
      denied.push({ serverId: server.serverId, code: "mcp_policy_default_deny" });
      continue;
    }
    runtime.push({
      id: server.serverId,
      label: server.label,
      url: entry.url,
      transport: entry.transport,
      revision: server.revision,
      policyRevision: policy.revision,
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      tools: readTools,
    });
  }
  return { servers: runtime, denied };
}

export async function loadEnabledMcpRuntime(
  database: D1Database,
  workspaceId: string,
  bindings: McpRegistryBindings,
  agentId: string,
) {
  const [servers, policy] = await Promise.all([
    listMcpServers(database, workspaceId),
    listMcpPolicySnapshot({ database, workspaceId, agentId }),
  ]);
  const selected = materializeMcpRuntime(servers, bindings, policy);
  return {
    ...selected,
    servers: await Promise.all(
      selected.servers.map(async (server) => ({
        ...server,
        credentialFingerprint: await mcpRuntimeBindingFingerprint(
          server.url,
          server.authorization,
        ),
      })),
    ),
  };
}

export async function mcpRuntimeBindingFingerprint(
  url: string,
  authorization?: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${url}\u0000${authorization ?? ""}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function assertMcpRuntimeServerCurrent(args: {
  database: D1Database;
  workspaceId: string;
  server: McpRuntimeServer;
  bindings: McpRegistryBindings;
}): Promise<void> {
  const current = await loadMcpServer(args.database, args.workspaceId, args.server.id);
  if (!current.enabled || current.status !== "connected") {
    throw new ApiError(403, "mcp_server_disabled", "The MCP server was disconnected or revoked before tool invocation.");
  }
  if (current.revision !== args.server.revision) {
    throw new ApiError(409, "mcp_server_revision_stale", "The MCP server changed after discovery. Refresh before invoking it.");
  }
  const entry = resolveMcpAllowlist(args.bindings).find(
    (candidate) => candidate.id === current.allowlistId,
  );
  if (!entry) throw new ApiError(403, "mcp_server_not_allowlisted", "The MCP server is no longer allowlisted.");
  // Re-resolve the secret on every invocation. Missing credentials deny the
  // transport call and are never included in the error or audit payload.
  const secret = resolveSecret(args.bindings, entry);
  const currentFingerprint = await mcpRuntimeBindingFingerprint(
    entry.url,
    secret ? `Bearer ${secret}` : undefined,
  );
  if (
    !args.server.credentialFingerprint ||
    args.server.credentialFingerprint !== currentFingerprint
  ) {
    throw new ApiError(409, "mcp_runtime_binding_stale", "The MCP endpoint or credential changed. Reconnect before invoking a tool.");
  }
}

export async function requireMcpAdministrator(
  request: Request,
  bindings: McpRegistryBindings,
): Promise<void> {
  const expected = configured(bindings.MCP_ADMIN_TOKEN);
  if (!expected) {
    throw new ApiError(503, "mcp_admin_unconfigured", "Configure the server-side MCP administrator token before changing the registry.");
  }
  const supplied = request.headers.get("x-conductor-mcp-admin")?.trim();
  if (!supplied) throw new ApiError(401, "mcp_admin_required", "MCP administrator authentication is required.");
  const encoder = new TextEncoder();
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const left = new Uint8Array(expectedHash);
  const right = new Uint8Array(suppliedHash);
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    difference |= left[index] ^ right[index];
  }
  if (difference !== 0) throw new ApiError(403, "mcp_admin_forbidden", "MCP administrator authentication failed.");
}

export function listMcpRegistrationOptions(bindings: McpRegistryBindings) {
  return resolveMcpAllowlist(bindings).map(({ id, label, transport }) => ({ id, label, transport }));
}
