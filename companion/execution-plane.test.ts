import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listWorkspace, readWorkspaceFile, runShellBatch } from "./execution-plane";

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

test("runs every approved batch command and preserves a non-zero result", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conductor-batch-"));
  const previousMode = process.env.CONDUCTOR_EXECUTION_MODE;
  process.env.CONDUCTOR_EXECUTION_MODE = "container";
  try {
    const result = await runShellBatch(root, {
      commands: [
        { command: "node -e \"process.stdout.write('first')\"", timeoutMs: 5_000 },
        { command: "node -e \"process.stderr.write('expected failure'); process.exit(3)\"", timeoutMs: 5_000 },
        { command: "node -e \"process.stdout.write('last')\"", timeoutMs: 5_000 },
      ],
    });
    assert.deepEqual(result.results.map((item) => item.exitCode), [0, 3, 0]);
    assert.equal(result.results[0]?.stdout, "first");
    assert.match(result.results[1]?.stderr ?? "", /expected failure/);
    assert.equal(result.results[2]?.stdout, "last");
  } finally {
    if (previousMode === undefined) delete process.env.CONDUCTOR_EXECUTION_MODE;
    else process.env.CONDUCTOR_EXECUTION_MODE = previousMode;
    await rm(root, { recursive: true, force: true });
  }
});
