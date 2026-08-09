import assert from "node:assert/strict";
import test from "node:test";

import { mcpServerActionSchema } from "../lib/mcp-contract.ts";

test("MCP lifecycle actions are workspace scoped and never accept an endpoint", () => {
  assert.deepEqual(
    mcpServerActionSchema.parse({
      action: "register",
      workspaceId: "workspace_local",
      allowlistId: "docker-mcp-gateway",
    }),
    {
      action: "register",
      workspaceId: "workspace_local",
      allowlistId: "docker-mcp-gateway",
    },
  );
  assert.throws(() =>
    mcpServerActionSchema.parse({
      action: "register",
      allowlistId: "docker-mcp-gateway",
      url: "https://attacker.example/mcp",
    }),
  );
  for (const action of ["connect", "disconnect", "refresh", "check_health", "revoke"]) {
    assert.equal(
      mcpServerActionSchema.parse({ action, serverId: "docker-mcp-gateway" }).action,
      action,
    );
  }
});
