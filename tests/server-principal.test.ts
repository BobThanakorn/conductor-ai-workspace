import assert from "node:assert/strict";
import test from "node:test";

import { createHandoffIdentityToken } from "../lib/handoff-identity.ts";
import { authenticateServerPrincipal } from "../lib/server-principal.ts";

test("server principal uses the trusted platform identity and never a request body actor", async () => {
  process.env.CONDUCTOR_TRUST_PLATFORM_IDENTITY = "true";
  const principal = await authenticateServerPrincipal(new Request("http://localhost", { headers: { "oai-authenticated-user-id": "Ada.Admin" } }), undefined, { workspaceId: "workspace_local" });
  assert.deepEqual(principal, { actorId: "user:ada.admin", kind: "trusted-user", workspaceId: "workspace_local" });
  delete process.env.CONDUCTOR_TRUST_PLATFORM_IDENTITY;
  await assert.rejects(() => authenticateServerPrincipal(new Request("http://localhost", { headers: { "oai-authenticated-user-id": "Ada.Admin" } }), "test-secret", { workspaceId: "workspace_local" }), /identity token is required/i);
});

test("local automation ownership requires a short-lived signed human identity", async () => {
  const token = await createHandoffIdentityToken({ actorId: "human:ada", role: "reviewer", kind: "human", workspaceId: "workspace_local", secret: "test-secret" });
  const principal = await authenticateServerPrincipal(new Request("http://localhost", { headers: { "x-conductor-identity": token } }), "test-secret", { workspaceId: "workspace_local" });
  assert.equal(principal.actorId, "human:ada");
  await assert.rejects(() => authenticateServerPrincipal(new Request("http://localhost"), "test-secret", { workspaceId: "workspace_local" }), /identity token is required/i);
});
