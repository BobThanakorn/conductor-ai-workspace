import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRuntimeCommand } from "./execution-plane";

test("legacy companion remote publication route is retired and terminal pushes are blocked", async (t) => {
  const port = 18765;
  process.env.CONDUCTOR_COMPANION_PORT = String(port);
  process.env.CONDUCTOR_COMPANION_HOST = "127.0.0.1";
  process.env.CONDUCTOR_WORKSPACE_ROOT = process.cwd();
  const { startCompanionServer } = await import("./local-git-server");
  const server = startCompanionServer();
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${port}/git/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: "push" }),
  });
  assert.equal(response.status, 410);
  assert.match((await response.json() as { error: string }).error, /retired/i);
  assert.throws(() => normalizeRuntimeCommand("git push --force origin main"), /permanently retired/i);
  assert.throws(() => normalizeRuntimeCommand("npm test && git send-pack origin main"), /retired|allowed|policy/i);
  assert.throws(() => normalizeRuntimeCommand("git -c alias.publish=!sh publish"), /retired/i);
  assert.throws(() => normalizeRuntimeCommand("sh -c 'git push origin main'"), /allowlist/i);
});
