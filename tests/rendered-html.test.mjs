import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("builds the Conductor workspace shell", async () => {
  const [page, layout, workspace, workspaceRoute, pythonRunner, pythonWorker, builtManifest] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/workspace-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/workspace/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/python-runner.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/python-runner.worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../dist/server/.vite/manifest.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<WorkspaceClient\s*\/>/);
  assert.match(layout, /Conductor — AI engineering workspace/);
  assert.match(workspace, /data-testid="conductor-workspace"/);
  assert.match(workspace, /Context inspector/);
  assert.match(workspace, /Approval required/);
  assert.match(workspace, /TASK TERMINAL/);
  assert.match(workspace, /fileTree/);
  assert.match(workspace, /eventStream/);
  assert.match(workspace, /Approve, create &amp; run/);
  assert.match(workspace, /runPythonSandbox/);
  assert.match(workspace, /workspaceFiles/);
  assert.match(workspace, /LOCAL_GIT_COMPANION/);
  assert.match(workspace, /git\/commit/);
  assert.match(pythonRunner, /new Worker\(PYTHON_RUNNER_WORKER_URL/);
  assert.match(pythonWorker, /runPythonAsync/);
  assert.match(pythonWorker, /jsglobals: noJavaScriptGlobals/);
  assert.match(workspaceRoute, /afterSequence/);
  assert.doesNotMatch(workspace, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
  assert.doesNotMatch(workspace, /Test runner started|Single-use capability issued/i);
  assert.ok(Object.keys(JSON.parse(builtManifest)).length > 0);
});

test("removes starter artifacts and declares durable state", async () => {
  const [page, layout, packageJson, hosting] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /WorkspaceClient/);
  assert.match(layout, /Conductor — AI engineering workspace/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.deepEqual(JSON.parse(hosting).d1, "DB");

  await access(new URL("../dist/client/python-runner.worker.mjs", import.meta.url));
  await assert.rejects(access(new URL("app/_sites-preview", root)));
});
