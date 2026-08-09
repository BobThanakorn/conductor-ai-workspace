import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { listWorkspace, normalizeRuntimeCommand, readWorkspaceFile, runShellBatch } from "./execution-plane";

test("normalizes the container Python executable without changing its arguments", () => {
  assert.equal(normalizeRuntimeCommand("python hello.py"), "python3 hello.py");
  assert.equal(normalizeRuntimeCommand("python3 hello.py"), "python3 hello.py");
  assert.throws(() => normalizeRuntimeCommand("python-tool hello.py"), /allowlist/i);
});

test("execution policy rejects shell, aliases, absolute executables, publication, and network escape wrappers", () => {
  for (const command of [
    "git push origin main",
    "git -c alias.release=!sh push",
    "git send-pack origin main",
    "sh -c 'curl https://example.test'",
    "powershell -Command Invoke-WebRequest",
    "env TOKEN=value npm test",
    "npx arbitrary-package",
    "/bin/bash -c whoami",
    "node -e \"fetch('https://example.test')\"",
    "npm test && curl https://example.test",
  ]) assert.throws(() => normalizeRuntimeCommand(command));
});

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
    await writeFile(path.join(root, "first.mjs"), "process.stdout.write('first')", "utf8");
    await writeFile(path.join(root, "failure.mjs"), "process.stderr.write('expected failure'); process.exit(3)", "utf8");
    await writeFile(path.join(root, "last.mjs"), "process.stdout.write('last')", "utf8");
    const result = await runShellBatch(root, {
      commands: [
        { command: "node first.mjs", timeoutMs: 5_000 },
        { command: "node failure.mjs", timeoutMs: 5_000 },
        { command: "node last.mjs", timeoutMs: 5_000 },
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

test("npm lifecycle scripts cannot conceal network or publication commands", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "conductor-npm-policy-"));
  const previousMode = process.env.CONDUCTOR_EXECUTION_MODE;
  process.env.CONDUCTOR_EXECUTION_MODE = "container";
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "git push origin main" } }), "utf8");
    await assert.rejects(() => runShellBatch(root, { commands: [{ command: "npm test", timeoutMs: 5_000 }] }), /no-publication\/no-network/i);
  } finally {
    if (previousMode === undefined) delete process.env.CONDUCTOR_EXECUTION_MODE;
    else process.env.CONDUCTOR_EXECUTION_MODE = previousMode;
    await rm(root, { recursive: true, force: true });
  }
});
