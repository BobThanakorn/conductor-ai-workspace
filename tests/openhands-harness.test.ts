import assert from "node:assert/strict";
import test from "node:test";

import { getOpenHandsHealth, OpenHandsHarnessError, runOpenHandsHarness } from "../lib/openhands-harness.ts";

const runtime = { provider: "openai", model: "test-model", apiKey: "test", baseURL: "https://example.test/v1" } as never;
const workspace = { repository: "repo", path: "tasks/task-123", branch: "task/task-123", headSha: "abc" };

test("OpenHands requires a task-bound relative worktree", async () => {
  await assert.rejects(
    () => runOpenHandsHarness({ serviceUrl: "http://openhands", runtime, message: "write", mode: "agent", workspaceFiles: [] }),
    (error: unknown) => error instanceof OpenHandsHarnessError && /task-bound/.test(error.message),
  );
  await assert.rejects(
    () => runOpenHandsHarness({ serviceUrl: "http://openhands", runtime, taskId: "task-123", workspace: { ...workspace, path: "../repo" }, message: "write", mode: "agent", workspaceFiles: [] }),
    (error: unknown) => error instanceof OpenHandsHarnessError && /relative/.test(error.message),
  );
});

test("OpenHands rejects malformed output fail-closed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes("app-conversations")) {
      return new Response(JSON.stringify({ app_conversation_id: "conversation-1" }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [{ content: "not json" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => runOpenHandsHarness({ serviceUrl: "http://openhands", runtime, taskId: "task-123", workspace, message: "write", mode: "agent", workspaceFiles: [] }),
      (error: unknown) => error instanceof OpenHandsHarnessError && /malformed/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenHands returns bounded Contract v2 proposal evidence", async () => {
  const originalFetch = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("app-conversations")) {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ app_conversation_id: "conversation-2" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      items: [{
        proposal: {
          summary: "เสนอการแก้ไข",
          plan: ["ตรวจสอบ"],
          proposedAction: "apply_and_run",
          riskLevel: "R1",
          needsApproval: true,
          evidence: ["task worktree"],
          artifacts: [{ path: "work/openhands.txt", content: "probe", language: "text" }],
          execution: null,
          executions: [{ command: "python3 -c \"print(1)\"", args: [], timeoutMs: 120000 }],
        },
      }],
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await runOpenHandsHarness({ serviceUrl: "http://openhands", runtime, taskId: "task-123", workspace, message: "Create a proposal", mode: "agent", workspaceFiles: [] });
    assert.equal(result.proposal.artifacts.length, 1);
    assert.equal(result.proposal.executions?.length, 1);
    assert.equal(result.proposal.needsApproval, true);
    assert.deepEqual((sent?.conductor as Record<string, unknown>).taskId, "task-123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenHands readiness is distinct from process health", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, ready: false, engine: "openhands" }), { status: 200 })) as typeof fetch;
  try {
    const health = await getOpenHandsHealth("http://openhands");
    assert.equal(health.ok, true);
    assert.equal(health.ready, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
