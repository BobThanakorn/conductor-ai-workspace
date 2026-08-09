import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ApiError } from "../lib/api-contract.ts";
import type { McpRuntimeServer, McpToolDescriptor } from "../lib/mcp-contract.ts";
import {
  authorizeMcpToolInvocation,
  evaluateMcpPolicy,
  invokePolicyCheckedMcpTool,
  mutateMcpPolicy,
} from "../lib/mcp-policy.ts";
import {
  assertMcpRuntimeServerCurrent,
  mcpRuntimeBindingFingerprint,
} from "../lib/mcp-registry.ts";

const readTool: McpToolDescriptor = {
  name: "search_code",
  description: "Search code",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  risk: "read",
  requiresApproval: false,
  serverId: "docker-mcp-gateway",
  provenance: {
    source: "mcp",
    serverId: "docker-mcp-gateway",
    transport: "streamable-http",
  },
};

const writeTool: McpToolDescriptor = {
  ...readTool,
  name: "create_issue",
  risk: "write",
  requiresApproval: true,
};

const registryRow = {
  workspace_id: "workspace_local",
  server_id: "docker-mcp-gateway",
  allowlist_id: "docker-mcp-gateway",
  label: "Docker MCP Gateway",
  status: "connected",
  enabled: 1,
  capabilities_json: "{}",
  tools_json: JSON.stringify([readTool, writeTool]),
  revision: 7,
  last_error_code: null,
  last_checked_at: "2026-08-07T00:00:00.000Z",
  created_at: "2026-08-07T00:00:00.000Z",
  updated_at: "2026-08-07T00:00:00.000Z",
};

function fakeInvocationDatabase(options: {
  server?: typeof registryRow | null;
  policyRevision?: number;
  workspaceDecision?: "allow" | "deny" | "inherit" | null;
  agentDecision?: "allow" | "deny" | "inherit" | null;
}): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args;
          return statement;
        },
        async first<T>() {
          if (sql.includes("FROM mcp_servers")) return (options.server ?? null) as T | null;
          if (sql.includes("FROM mcp_policy_state")) {
            return { revision: options.policyRevision ?? 0 } as T;
          }
          if (sql.includes("FROM mcp_tool_policies")) {
            const scopeType = values[1];
            const decision = scopeType === "workspace"
              ? options.workspaceDecision
              : options.agentDecision;
            if (!decision) return null;
            return {
              workspace_id: "workspace_local",
              scope_type: scopeType,
              scope_id: values[2],
              server_id: "docker-mcp-gateway",
              tool_name: "search_code",
              decision,
              risk: "read",
              requires_approval: 0,
              revision: options.policyRevision ?? 0,
              updated_by: "mcp-administrator",
              created_at: "2026-08-07T00:00:00.000Z",
              updated_at: "2026-08-07T00:00:00.000Z",
            } as T;
          }
          return null;
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

function runtimeServer(): McpRuntimeServer {
  return {
    id: "docker-mcp-gateway",
    label: "Docker MCP Gateway",
    url: "http://mcp-gateway:8811",
    transport: "streamable-http",
    revision: 7,
    policyRevision: 3,
    tools: [{ ...readTool, serverRevision: 7, policyRevision: 3 }],
  };
}

test("policy is default deny and an agent can only narrow workspace permission", () => {
  assert.deepEqual(evaluateMcpPolicy(undefined, undefined), {
    effectiveDecision: "deny",
    reason: "workspace_default_deny",
  });
  assert.deepEqual(evaluateMcpPolicy("inherit", "allow"), {
    effectiveDecision: "deny",
    reason: "workspace_default_deny",
  });
  assert.deepEqual(evaluateMcpPolicy("allow", "inherit"), {
    effectiveDecision: "allow",
    reason: "workspace_allowed",
  });
  assert.deepEqual(evaluateMcpPolicy("allow", "deny"), {
    effectiveDecision: "deny",
    reason: "agent_denied",
  });
  assert.deepEqual(evaluateMcpPolicy("deny", "allow"), {
    effectiveDecision: "deny",
    reason: "workspace_denied",
  });
});

test("invocation re-check permits an unchanged read policy", async () => {
  const descriptor = await authorizeMcpToolInvocation({
    database: fakeInvocationDatabase({
      server: registryRow,
      policyRevision: 3,
      workspaceDecision: "allow",
      agentDecision: "inherit",
    }),
    workspaceId: "workspace_local",
    agentId: "openai-agents",
    serverId: "docker-mcp-gateway",
    toolName: "search_code",
    expectedServerRevision: 7,
    expectedPolicyRevision: 3,
  });
  assert.equal(descriptor.name, "search_code");
});

for (const scenario of [
  {
    name: "revoked server",
    database: fakeInvocationDatabase({
      server: { ...registryRow, status: "revoked", enabled: 0, revision: 8 },
      policyRevision: 3,
      workspaceDecision: "allow",
    }),
    code: "mcp_server_disabled",
  },
  {
    name: "stale server revision",
    database: fakeInvocationDatabase({
      server: { ...registryRow, revision: 8 },
      policyRevision: 3,
      workspaceDecision: "allow",
    }),
    code: "mcp_server_revision_stale",
  },
  {
    name: "stale policy revision",
    database: fakeInvocationDatabase({
      server: registryRow,
      policyRevision: 4,
      workspaceDecision: "allow",
    }),
    code: "mcp_policy_revision_stale",
  },
  {
    name: "new agent deny",
    database: fakeInvocationDatabase({
      server: registryRow,
      policyRevision: 3,
      workspaceDecision: "allow",
      agentDecision: "deny",
    }),
    code: "mcp_tool_denied",
  },
] as const) {
  test(`${scenario.name} prevents transport invocation`, async () => {
    let transportCalls = 0;
    await assert.rejects(
      invokePolicyCheckedMcpTool({
        authorize: () =>
          authorizeMcpToolInvocation({
            database: scenario.database,
            workspaceId: "workspace_local",
            agentId: "openai-agents",
            serverId: "docker-mcp-gateway",
            toolName: "search_code",
            expectedServerRevision: 7,
            expectedPolicyRevision: 3,
          }),
        transport: async () => {
          transportCalls += 1;
          return "should-not-run";
        },
      }),
      (error: unknown) => error instanceof ApiError && error.code === scenario.code,
    );
    assert.equal(transportCalls, 0);
  });
}

for (const scenario of [
  {
    name: "removed allowlist entry",
    bindings: { MCP_SERVER_ALLOWLIST: "[]" },
    code: "mcp_server_not_allowlisted",
  },
  {
    name: "missing server-side secret",
    bindings: {
      MCP_SERVER_ALLOWLIST: JSON.stringify([
        {
          id: "docker-mcp-gateway",
          label: "Docker MCP Gateway",
          url: "http://mcp-gateway:8811",
          secretRef: "MCP_GATEWAY_AUTH_TOKEN",
        },
      ]),
    },
    code: "mcp_secret_unavailable",
  },
] as const) {
  test(`${scenario.name} is re-checked and causes zero transport calls`, async () => {
    let transportCalls = 0;
    await assert.rejects(
      invokePolicyCheckedMcpTool({
        authorize: () =>
          assertMcpRuntimeServerCurrent({
            database: fakeInvocationDatabase({ server: registryRow }),
            workspaceId: "workspace_local",
            server: runtimeServer(),
            bindings: scenario.bindings,
          }),
        transport: async () => {
          transportCalls += 1;
          return "should-not-run";
        },
      }),
      (error: unknown) => error instanceof ApiError && error.code === scenario.code,
    );
    assert.equal(transportCalls, 0);
  });
}

test("side-effecting descriptors remain blocked without a payload-bound approval bridge", async () => {
  const database = fakeInvocationDatabase({
    server: { ...registryRow, tools_json: JSON.stringify([writeTool]) },
    policyRevision: 3,
    workspaceDecision: "allow",
  });
  await assert.rejects(
    authorizeMcpToolInvocation({
      database,
      workspaceId: "workspace_local",
      agentId: "openai-agents",
      serverId: "docker-mcp-gateway",
      toolName: "create_issue",
      expectedServerRevision: 7,
      expectedPolicyRevision: 3,
    }),
    (error: unknown) => error instanceof ApiError && error.code === "mcp_tool_approval_required",
  );
});

test("rotated credentials invalidate the cached transport before it is called", async () => {
  let transportCalls = 0;
  const server = runtimeServer();
  server.credentialFingerprint = await mcpRuntimeBindingFingerprint(
    server.url,
    "Bearer old-secret",
  );
  await assert.rejects(
    invokePolicyCheckedMcpTool({
      authorize: () =>
        assertMcpRuntimeServerCurrent({
          database: fakeInvocationDatabase({ server: registryRow }),
          workspaceId: "workspace_local",
          server,
          bindings: {
            MCP_SERVER_ALLOWLIST: JSON.stringify([
              {
                id: "docker-mcp-gateway",
                label: "Docker MCP Gateway",
                url: "http://mcp-gateway:8811",
                secretRef: "MCP_GATEWAY_AUTH_TOKEN",
              },
            ]),
            MCP_GATEWAY_AUTH_TOKEN: "new-secret",
          },
        }),
      transport: async () => {
        transportCalls += 1;
        return "should-not-run";
      },
    }),
    (error: unknown) => error instanceof ApiError && error.code === "mcp_runtime_binding_stale",
  );
  assert.equal(transportCalls, 0);
});

test("agent allow mutation cannot broaden a default-deny workspace", async () => {
  let batchCalls = 0;
  const database = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args;
          return statement;
        },
        async first<T>() {
          if (sql.includes("mcp_policy_events")) return null;
          if (sql.includes("FROM workspaces")) return { id: "workspace_local" } as T;
          if (sql.includes("SELECT tools_json FROM mcp_servers")) {
            return { tools_json: JSON.stringify([readTool]) } as T;
          }
          if (sql.includes("FROM mcp_policy_state")) return { revision: 0 } as T;
          if (sql.includes("FROM mcp_tool_policies")) return null;
          throw new Error(`Unexpected first query: ${sql} ${values.length}`);
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch() {
      batchCalls += 1;
      return [];
    },
  } as unknown as D1Database;
  await assert.rejects(
    mutateMcpPolicy({
      database,
      workspaceId: "workspace_local",
      idempotencyKey: "policy-test-0001",
      actorId: "mcp-administrator",
      input: {
        workspaceId: "workspace_local",
        expectedRevision: 0,
        scope: { type: "agent", agentId: "openai-agents" },
        serverId: "docker-mcp-gateway",
        toolName: "search_code",
        decision: "allow",
      },
    }),
    (error: unknown) => error instanceof ApiError && error.code === "mcp_agent_scope_expansion",
  );
  assert.equal(batchCalls, 0);
});

test("policy audit schema is append-only and contains no credential or argument fields", async () => {
  const [store, schema, route, migration] = await Promise.all([
    readFile(new URL("../lib/environment-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/mcp/policies/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0006_cold_peter_quill.sql", import.meta.url), "utf8"),
  ]);
  assert.match(store, /mcp_policy_events are append-only/);
  assert.match(schema, /mcpPolicyEvents/);
  assert.doesNotMatch(schema, /argumentsJson|tokenJson|authorizationJson|secretJson/);
  assert.match(route, /requireMcpAdministrator/);
  assert.match(route, /requireIdempotencyKey/);
  assert.doesNotMatch(route, /actorId:\s*body|input\.actor/);
  assert.match(migration, /mcp_policy_events_no_update/);
  assert.match(migration, /mcp_policy_events_no_delete/);
});
