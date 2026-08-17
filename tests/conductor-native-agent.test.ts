import assert from "node:assert/strict";
import test from "node:test";

import { runConductorNativeAgent } from "../lib/conductor-native-agent.ts";

test("Conductor Native runs read-only companion tools and returns a proposal", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  let providerTurn = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/chat/completions")) {
      providerTurn += 1;
      if (providerTurn === 1) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "call_1", type: "function", function: { name: "git_status", arguments: "{}" } }],
            },
          }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              summary: "ตรวจสอบสถานะแล้ว",
              plan: ["ตรวจสอบข้อมูลแบบอ่านอย่างเดียว"],
              proposedAction: "read_only_answer",
              riskLevel: "R0",
              needsApproval: false,
              evidence: ["git.status"],
              artifacts: [],
              execution: null,
              executions: [],
            }),
          },
        }],
        usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
      }), { status: 200 });
    }
    calls.push(url);
    assert.equal(init?.method, "GET");
    return new Response(JSON.stringify({ ok: true, files: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await runConductorNativeAgent({
      runtime: { provider: "openai", apiKey: "test", baseURL: "http://localhost:8000/v1", model: "qwen3.6" },
      message: "ตรวจสอบสถานะ repository",
      mode: "ask",
      workspaceFiles: [],
      companionUrl: "http://companion:8765",
    });
    assert.equal(result.output.riskLevel, "R0");
    assert.deepEqual(calls, ["http://companion:8765/git/status"]);
    assert.equal(result.telemetry.tools[0]?.name, "git.status");
    assert.equal(result.telemetry.tokenUsage.requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Conductor Native fails closed when the provider is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(
      () => runConductorNativeAgent({
        runtime: { provider: "openai", apiKey: "test", baseURL: "http://localhost:8000/v1", model: "qwen3.6" },
        message: "สร้างไฟล์",
        mode: "agent",
        workspaceFiles: [],
      }),
      /HTTP 503/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
