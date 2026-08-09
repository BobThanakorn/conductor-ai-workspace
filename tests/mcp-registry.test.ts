import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { McpRegistryServer } from "../lib/mcp-contract.ts";
import {
  materializeMcpRuntime,
  listMcpRegistrationOptions,
  requireMcpAdministrator,
  resolveMcpAllowlist,
} from "../lib/mcp-registry.ts";

const baseServer: McpRegistryServer = {
  workspaceId: "workspace_local",
  serverId: "docker-mcp-gateway",
  allowlistId: "docker-mcp-gateway",
  label: "Docker MCP Gateway",
  status: "connected",
  enabled: true,
  revision: 1,
  capabilities: { tools: {} },
  tools: [
    {
      name: "search_code",
      inputSchema: { type: "object" },
      risk: "read",
      requiresApproval: false,
      serverId: "docker-mcp-gateway",
      provenance: {
        source: "mcp",
        serverId: "docker-mcp-gateway",
        transport: "streamable-http",
      },
    },
    {
      name: "create_issue",
      inputSchema: { type: "object" },
      risk: "write",
      requiresApproval: true,
      serverId: "docker-mcp-gateway",
      provenance: {
        source: "mcp",
        serverId: "docker-mcp-gateway",
        transport: "streamable-http",
      },
    },
  ],
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

test("allowlist is administrator configured and rejects SSRF-prone entries", () => {
  assert.deepEqual(resolveMcpAllowlist({ MCP_GATEWAY_URL: "http://mcp-gateway:8811" }), [
    {
      id: "docker-mcp-gateway",
      label: "Docker MCP Gateway",
      url: "http://mcp-gateway:8811",
      transport: "streamable-http",
    },
  ]);
  assert.throws(() =>
    resolveMcpAllowlist({
      MCP_SERVER_ALLOWLIST: JSON.stringify([
        { id: "unsafe", label: "Unsafe", url: "http://169.254.169.254/latest/meta-data" },
      ]),
    }),
  );
  const options = listMcpRegistrationOptions({
    MCP_SERVER_ALLOWLIST: JSON.stringify([
      {
        id: "official",
        label: "Official",
        url: "https://mcp.example.test/rpc",
        secretRef: "MCP_TEST_SECRET",
      },
    ]),
    MCP_TEST_SECRET: "not-returned",
  });
  assert.deepEqual(options, [
    { id: "official", label: "Official", transport: "streamable-http" },
  ]);
  assert.equal(JSON.stringify(options).includes("not-returned"), false);
  assert.equal(JSON.stringify(options).includes("mcp.example.test"), false);
});

test("runtime selection defaults to deny and exposes only explicitly allowed read tools", () => {
  const bindings = { MCP_GATEWAY_URL: "http://mcp-gateway:8811" };
  const defaultDenied = materializeMcpRuntime([baseServer], bindings);
  assert.equal(defaultDenied.servers.length, 0);
  assert.deepEqual(defaultDenied.denied, [
    { serverId: "docker-mcp-gateway", code: "mcp_policy_default_deny" },
  ]);

  const selected = materializeMcpRuntime(
    [baseServer, { ...baseServer, serverId: "disabled", allowlistId: "disabled", status: "disconnected", enabled: false }],
    bindings,
    {
      revision: 4,
      effective: [
        {
          serverId: "docker-mcp-gateway",
          toolName: "search_code",
          risk: "read",
          effectiveDecision: "allow",
        },
        {
          serverId: "docker-mcp-gateway",
          toolName: "create_issue",
          risk: "write",
          effectiveDecision: "allow",
        },
      ],
    },
  );
  assert.equal(selected.servers.length, 1);
  assert.deepEqual(selected.servers[0].tools.map((tool) => tool.name), ["search_code"]);
  assert.equal(selected.servers[0].policyRevision, 4);
  assert.equal(selected.servers[0].tools[0]?.serverRevision, 1);
  assert.deepEqual(selected.denied, [{ serverId: "disabled", code: "mcp_server_disabled" }]);

  for (const status of ["revoked", "unavailable"] as const) {
    const denied = materializeMcpRuntime(
      [{ ...baseServer, status, enabled: false }],
      bindings,
    );
    assert.equal(denied.servers.length, 0);
    assert.deepEqual(denied.denied, [
      { serverId: "docker-mcp-gateway", code: "mcp_server_disabled" },
    ]);
  }

  const removed = materializeMcpRuntime([baseServer], { MCP_SERVER_ALLOWLIST: "[]" });
  assert.equal(removed.servers.length, 0);
  assert.deepEqual(removed.denied, [
    { serverId: "docker-mcp-gateway", code: "mcp_server_not_allowlisted" },
  ]);
});

test("registry mutations require a server-side administrator token", async () => {
  const request = (token?: string) =>
    new Request("http://localhost/api/mcp", {
      headers: token ? { "X-Conductor-MCP-Admin": token } : {},
    });
  await assert.rejects(requireMcpAdministrator(request(), {}), /Configure the server-side MCP administrator token/);
  await assert.rejects(
    requireMcpAdministrator(request("wrong"), { MCP_ADMIN_TOKEN: "correct" }),
    /authentication failed/,
  );
  await requireMcpAdministrator(request("correct"), { MCP_ADMIN_TOKEN: "correct" });
});

test("registry state and audit events are durable and append-only", async () => {
  const [store, route] = await Promise.all([
    readFile(new URL("../lib/environment-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/mcp/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(store, /CREATE TABLE IF NOT EXISTS mcp_servers/);
  assert.match(store, /CREATE TABLE IF NOT EXISTS mcp_registry_events/);
  assert.match(store, /mcp_registry_events are append-only/);
  assert.doesNotMatch(route, /input\.url|body\.url/);
  assert.match(route, /requireMcpAdministrator/);
});
