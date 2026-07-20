import assert from "node:assert/strict";
import test from "node:test";

import { approveAction, consumeApproval, requestApproval } from "./approval-store";

test("approval tokens are single-use and payload-bound", () => {
  const input = { command: "npm test", cwd: ".", timeoutMs: 120_000 };
  const request = requestApproval("terminal.execute", input);
  const approved = approveAction(request.approvalId, request.digest);
  assert.doesNotThrow(() => consumeApproval(approved.token, "terminal.execute", input));
  assert.throws(() => consumeApproval(approved.token, "terminal.execute", input), /invalid|reused/i);
});

test("approval rejects a changed action payload", () => {
  const input = { files: [{ path: "main.py", content: "print('safe')\n" }] };
  const request = requestApproval("fs.write", input);
  const approved = approveAction(request.approvalId, request.digest);
  assert.throws(
    () => consumeApproval(approved.token, "fs.write", { files: [{ path: "main.py", content: "print('changed')\n" }] }),
    /different action/i,
  );
});
