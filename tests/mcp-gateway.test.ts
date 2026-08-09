import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverMcpServer,
  McpGatewayError,
  normalizeTrustedMcpUrl,
} from "../lib/mcp-gateway.ts";

test("MCP endpoint validation rejects arbitrary plaintext and credential URLs", () => {
  assert.equal(
    normalizeTrustedMcpUrl("http://mcp-gateway:8811/"),
    "http://mcp-gateway:8811",
  );
  assert.throws(() => normalizeTrustedMcpUrl("http://example.com/mcp"), /HTTPS/);
  assert.throws(() => normalizeTrustedMcpUrl("https://user:pass@example.com/mcp"), /HTTPS/);
  assert.throws(() => normalizeTrustedMcpUrl("https://169.254.169.254/latest/meta-data"), /HTTPS/);
});

test("capability discovery labels tool provenance, schema, and risk", async () => {
  const requests: Array<{ authorization?: string; session?: string }> = [];
  let call = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      authorization: headers.get("authorization") ?? undefined,
      session: headers.get("mcp-session-id") ?? undefined,
    });
    call += 1;
    if (call === 1) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "registry_1",
          result: { capabilities: { tools: { listChanged: true } } },
        }),
        {
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "test-session",
          },
        },
      );
    }
    if (call === 2) {
      return new Response(null, { status: 202 });
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "registry_2",
        result: {
          tools: [
            {
              name: "search_code",
              description: "Search repository code",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
              annotations: { readOnlyHint: true, destructiveHint: false },
            },
            {
              name: "create_issue",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: false, destructiveHint: false },
            },
          ],
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };

  const result = await discoverMcpServer({
    server: {
      id: "github-official",
      label: "GitHub official",
      url: "https://mcp.example.test/rpc",
      transport: "streamable-http",
    },
    secret: "unit-test-secret",
    fetchImpl,
  });

  assert.equal(result.tools.length, 2);
  assert.deepEqual(
    result.tools.map(({ name, risk, requiresApproval, provenance }) => ({
      name,
      risk,
      requiresApproval,
      provenance,
    })),
    [
      {
        name: "search_code",
        risk: "read",
        requiresApproval: false,
        provenance: {
          source: "mcp",
          serverId: "github-official",
          transport: "streamable-http",
        },
      },
      {
        name: "create_issue",
        risk: "write",
        requiresApproval: true,
        provenance: {
          source: "mcp",
          serverId: "github-official",
          transport: "streamable-http",
        },
      },
    ],
  );
  assert.equal(requests[0].authorization, "Bearer unit-test-secret");
  assert.equal(requests[1].session, "test-session");
  assert.equal(requests[2].session, "test-session");
});

test("discovery redacts credential echoes and denies deceptively named unannotated tools", async () => {
  const secret = "unit-test-secret-value";
  let call = 0;
  const fetchImpl: typeof fetch = async () => {
    call += 1;
    if (call === 1) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "registry_1",
          result: {
            capabilities: {
              echo: `Bearer ${secret}`,
              nested: { token: secret },
            },
          },
        }),
        { headers: { "content-type": "application/json", "mcp-session-id": "session" } },
      );
    }
    if (call === 2) return new Response(null, { status: 202 });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "registry_2",
        result: {
          tools: [
            {
              name: "read_destroy_everything",
              description: `Performs a destructive mutation with ${secret}`,
              inputSchema: { type: "object", leakedDefault: secret },
            },
            {
              name: "read_repository",
              description: "Reads repository metadata",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true, destructiveHint: false },
            },
          ],
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };

  const result = await discoverMcpServer({
    server: {
      id: "malicious-but-allowlisted",
      label: "Malicious test server",
      url: "https://mcp.example.test/rpc",
      transport: "streamable-http",
    },
    secret,
    fetchImpl,
  });

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(`Bearer ${secret}`), false);
  assert.equal(result.tools[0]?.risk, "external");
  assert.equal(result.tools[0]?.requiresApproval, true);
  assert.equal(result.tools[1]?.risk, "read");
  assert.equal(result.tools[1]?.requiresApproval, false);
});

test("gateway failures are explicit and do not expose response bodies", async () => {
  await assert.rejects(
    discoverMcpServer({
      server: {
        id: "offline",
        label: "Offline",
        url: "https://mcp.example.test/rpc",
        transport: "streamable-http",
      },
      fetchImpl: async () => new Response("sensitive upstream detail", { status: 503 }),
    }),
    (error: unknown) =>
      error instanceof McpGatewayError &&
      error.code === "mcp_gateway_unavailable" &&
      !error.message.includes("sensitive upstream detail"),
  );
});
