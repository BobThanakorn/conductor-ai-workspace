import assert from "node:assert/strict";
import test from "node:test";

import { runExternalHarness } from "../lib/external-harness.ts";

test("external harness adapter accepts a schema-valid Contract v2 proposal", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      ok: true,
      answer: "ignored",
      proposal: {
        summary: "สร้างไฟล์หลังอนุมัติ",
        plan: ["สร้างไฟล์"],
        proposedAction: "write_file",
        riskLevel: "R1",
        needsApproval: true,
        evidence: ["อยู่ใน workspace"],
        artifacts: [{ path: "hello.py", content: "print('ok')", language: "python" }],
        execution: null,
        executions: ["python3 -c \\\"print(1)\\\""],
      },
      metrics: { durationMs: 12, tokenUsage: { requests: 1, inputTokens: 2, outputTokens: 3, totalTokens: 5 }, tools: [] },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await runExternalHarness({
      serviceUrl: "http://agent-pydanticai:8020",
      engine: "pydantic-ai",
      runtime: { provider: "azure", model: "gpt-5.1-codex-mini", apiKey: "test", baseURL: "https://example.com/openai/v1" } as never,
      message: "สร้างไฟล์",
      mode: "agent",
      workspaceFiles: [],
    });
    assert.equal(requestBody?.mode, "agent");
    assert.ok(result.proposal);
    assert.equal(result.proposal.artifacts[0]?.path, "hello.py");
    assert.equal(result.proposal.executions?.[0]?.command, 'python3 -c "print(1)"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("external harness preserves real read-only companion tool events", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: true,
    answer: "อ่านไฟล์แล้ว",
    metrics: {
      durationMs: 8,
      tokenUsage: { requests: 2, inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      tools: [
        { name: "fs.read", status: "called", source: "companion", risk: "read" },
        { name: "fs.read", status: "completed", source: "companion", risk: "read" },
      ],
    },
  }), { status: 200 })) as typeof fetch;
  try {
    const result = await runExternalHarness({
      serviceUrl: "http://agent-pydanticai:8020",
      engine: "pydantic-ai",
      runtime: { provider: "azure", model: "gpt-5.1-codex-mini", apiKey: "test", baseURL: "https://example.com/openai/v1" } as never,
      message: "อ่าน README",
      mode: "ask",
      workspaceFiles: [],
    });
    assert.deepEqual(result.metrics?.tools?.map((tool) => [tool.name, tool.status]), [
      ["fs.read", "called"],
      ["fs.read", "completed"],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
