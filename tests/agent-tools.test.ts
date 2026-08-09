import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyAgentToolRisk,
  normalizeAgentToolEvent,
  normalizeToolFailure,
  toolRequiresApproval,
} from "../lib/agent-tools.ts";

test("shared tool adapter classifies read-only tools", () => {
  assert.equal(classifyAgentToolRisk("mcp.read_file"), "read");
  const event = normalizeAgentToolEvent({ name: "mcp.read_file", status: "completed" });
  assert.deepEqual(event, {
    name: "mcp.read_file",
    status: "completed",
    source: "mcp",
    risk: "read",
    approved: false,
  });
  assert.equal(toolRequiresApproval(event), false);
});

test("shared tool adapter keeps mutating tool events unapproved", () => {
  assert.equal(classifyAgentToolRisk("terminal.execute-batch"), "execute");
  const event = normalizeAgentToolEvent({
    name: "terminal.execute-batch",
    status: "called",
    source: "model",
    approved: true,
  });
  assert.equal(event.approved, false);
  assert.equal(toolRequiresApproval(event), true);
});

test("shared tool adapter normalizes failures and redacts secrets", () => {
  assert.deepEqual(normalizeToolFailure(new Error("token ghp_12345678901234567890 leaked"), "fs.write"), {
    code: "tool_failed",
    message: "token [redacted-secret] leaked",
    tool: "fs.write",
  });
});
