import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentContractV2, mutationPayloadSchema } from "../lib/agent-contract.ts";

const proposal = {
  summary: "สร้างไฟล์และตรวจสอบผลลัพธ์",
  plan: ["สร้างไฟล์", "รันการตรวจสอบ"],
  proposedAction: "apply_and_run",
  riskLevel: "R1" as const,
  needsApproval: true,
  evidence: ["คำสั่งถูกจำกัดใน workspace"],
  artifacts: [{ path: "hello.py", content: "print('hello')", language: "python" }],
  execution: { entrypoint: "hello.py", args: [], timeoutMs: 5000 },
  executions: [{ command: "python3 hello.py", args: [], timeoutMs: 5000 }],
};

test("Agent Contract v2 binds the complete mutation to the exact workspace snapshot", () => {
    const contract = buildAgentContractV2({
      runId: "run_test_001",
      framework: "openai-agents",
      model: "gpt-5.1-codex-mini",
      mode: "agent",
      workspaceId: "workspace",
      taskId: "task_1",
      snapshot: { repository: "repo", branch: "main", headSha: "abc123" },
      proposal,
    });

    assert.equal(contract.contractVersion, 2);
    assert.equal(contract.approval.required, true);
    assert.deepEqual(contract.approval.payload, contract.mutation);
    assert.equal(contract.mutation.artifacts.length, 1);
    assert.equal(contract.mutation.executions.length, 1);
    assert.deepEqual(contract.mutation.operations.map((operation) => operation.action), ["fs.write", "terminal.execute-batch"]);
    assert.equal(contract.mutation.snapshot.headSha, "abc123");
});

test("Agent Contract v2 does not create a mutation approval for an Ask response", () => {
    const contract = buildAgentContractV2({
      runId: "run_test_002",
      framework: "langgraph",
      model: "gpt-5.1-codex-mini",
      mode: "ask",
      workspaceId: "workspace",
      snapshot: { repository: "repo" },
      proposal: { ...proposal, needsApproval: false, riskLevel: "R0", artifacts: [], execution: null, executions: [] },
    });
    assert.deepEqual(contract.approval, { required: false, payload: null });
    assert.deepEqual(contract.mutation.artifacts, []);
});

test("Agent Contract v2 rejects mutation payloads without snapshot", () => {
    assert.throws(() => mutationPayloadSchema.parse({
      action: "apply",
      workspaceId: "workspace",
      taskId: "task_1",
      artifacts: [],
      execution: null,
      executions: [],
      operations: [],
    }));
});

test("Agent Contract v2 requires approval for mutation even without a task", () => {
  const contract = buildAgentContractV2({
    runId: "run_test_003",
    framework: "openai-agents",
    model: "gpt-5.1-codex-mini",
    mode: "agent",
    workspaceId: "workspace",
    snapshot: { repository: "repo" },
    proposal,
  });
  assert.equal(contract.approval.required, true);
  assert.equal(contract.approval.payload?.taskId, null);
});
