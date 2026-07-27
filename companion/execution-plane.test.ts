import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listWorkspace, readWorkspaceFile } from "./execution-plane";

test("workspace listing and reads exclude secret-bearing paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conductor-workspace-"));
  try {
    await writeFile(path.join(root, ".env"), "TOKEN=secret", "utf8");
    await writeFile(path.join(root, ".env.example"), "TOKEN=", "utf8");
    await writeFile(path.join(root, "secret.azure-api-key"), "secret", "utf8");
    await writeFile(path.join(root, "README.md"), "safe", "utf8");

    const entries = await listWorkspace(root, ".", 2) as Array<{ name: string }>;
    assert.deepEqual(entries.map((entry) => entry.name).sort(), [".env.example", "README.md"]);
    await assert.rejects(readWorkspaceFile(root, ".env"), /Sensitive environment/);
    await assert.rejects(readWorkspaceFile(root, "secret.azure-api-key"), /Sensitive environment/);
    assert.equal((await readWorkspaceFile(root, "README.md")).content, "safe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
