import assert from "node:assert/strict";
import test from "node:test";

import { parseContractMutation } from "../companion/contract-binding.ts";

const mutation = {
  action: "apply_and_run",
  workspaceId: "workspace",
  taskId: "task_1",
  snapshot: { repository: "repo", branch: "main" },
  artifacts: [{ path: "hello.py", content: "print('ok')", language: "python" }],
  execution: null,
  executions: [],
  operations: [
    { action: "fs.write", input: { files: [{ path: "hello.py", content: "print('ok')" }] } },
    { action: "terminal.execute-batch", input: { commands: [{ command: "python3 hello.py", cwd: ".", timeoutMs: 5000 }] } },
  ],
};

test("companion validates Contract v2 artifact binding before approval", () => {
  assert.deepEqual(
    parseContractMutation({ contractVersion: 2, contractMutation: mutation, files: mutation.artifacts }, "fs.write"),
    mutation,
  );
  assert.throws(
    () => parseContractMutation({ contractVersion: 2, contractMutation: mutation, files: [{ path: "hello.py", content: "tampered" }] }, "fs.write"),
    /does not match/,
  );
});

test("companion binds both write and execute to one approved mutation", () => {
  assert.deepEqual(
    parseContractMutation({ contractVersion: 2, contractMutation: mutation, commands: [{ command: "python hello.py", cwd: ".", timeoutMs: 5000 }] }, "terminal.execute-batch"),
    mutation,
  );
});

test("companion rejects an unauthorized Contract v2 tool", () => {
  assert.throws(
    () => parseContractMutation({ contractVersion: 2, contractMutation: mutation, commands: [] }, "terminal.execute-batch"),
    /does not match/,
  );
});
