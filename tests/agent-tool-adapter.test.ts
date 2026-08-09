import assert from "node:assert/strict";
import test from "node:test";

import {
  bindContractMutation,
  getCompanionToolDefinition,
  invokeApprovedCompanionTool,
  invokeReadOnlyMcpTool,
} from "../lib/agent-tool-adapter.ts";

test("companion adapter binds the same contract mutation to approval input", () => {
  const mutation = { workspaceId: "workspace", artifacts: [{ path: "hello.py" }] };
  assert.deepEqual(bindContractMutation({ files: mutation.artifacts }, mutation), {
    files: mutation.artifacts,
    contractVersion: 2,
    contractMutation: mutation,
  });
  assert.equal(getCompanionToolDefinition("terminal.execute-batch").requiresApproval, true);
  assert.equal(getCompanionToolDefinition("mcp.read").requiresApproval, false);
});

test("MCP adapter rejects mutating tool names before transport", async () => {
  await assert.rejects(
    () => invokeReadOnlyMcpTool({
      gatewayUrl: "http://mcp-gateway:8811",
      name: "delete_file",
      transport: async () => ({ ok: true }),
    }),
    /read-only MCP/,
  );
});

test("MCP adapter sends a bounded read-only tools/call envelope", async () => {
  let captured: Record<string, unknown> | undefined;
  const result = await invokeReadOnlyMcpTool({
    gatewayUrl: "http://mcp-gateway:8811",
    name: "read_file",
    arguments: { path: "README.md" },
    transport: async (_url, body) => {
      captured = body;
      return { ok: true };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured?.method, "tools/call");
  assert.deepEqual(captured?.params, { name: "read_file", arguments: { path: "README.md" } });
});

test("approved companion execution reuses the exact contract-bound payload", async () => {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(input), body });
    if (String(input).endsWith("/approvals/request")) {
      return new Response(JSON.stringify({ approvalId: "apr_1", digest: "digest_1" }), { status: 200 });
    }
    if (String(input).endsWith("/approvals/approve")) {
      return new Response(JSON.stringify({ token: "approval_token" }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, stdout: "done" }), { status: 200 });
  }) as typeof fetch;
  try {
    const mutation = {
      action: "fs.write",
      workspaceId: "workspace",
      taskId: "task_1",
      snapshot: { repository: "repo", branch: "main" },
      artifacts: [{ path: "hello.py", content: "print('ok')", language: "python" }],
      execution: null,
      executions: [],
    };
    await invokeApprovedCompanionTool({
      baseUrl: "http://localhost:8765",
      tool: "fs.write",
      input: { files: mutation.artifacts },
      contractMutation: mutation,
    });
    const requestEnvelope = calls[0]?.body as { action?: unknown; input?: Record<string, unknown> } | undefined;
    assert.deepEqual(requestEnvelope?.input, calls[2]?.body);
    const requestBody = requestEnvelope?.input as { contractVersion?: unknown; contractMutation?: unknown } | undefined;
    assert.equal(requestBody?.contractVersion, 2);
    assert.deepEqual(requestBody?.contractMutation, mutation);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
