import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workerPath = path.join(process.cwd(), "public", "python-runner.worker.mjs");

test("worker module parses and pins the approved Pyodide distribution", async () => {
  await execFileAsync(process.execPath, ["--check", workerPath]);
  const source = await readFile(workerPath, "utf8");
  const pinned = "https://cdn.jsdelivr.net/pyodide/v314.0.2/full/pyodide.mjs";
  assert.match(source, new RegExp(`import \\{ loadPyodide \\} from "${escapeRegex(pinned)}"`));
  assert.match(source, /indexURL: PYODIDE_INDEX/);
  assert.doesNotMatch(source, /\/pyodide\/(?:dev|latest)\//);
});

test("worker exposes no JavaScript globals or package-install escape hatch", async () => {
  const source = await readFile(workerPath, "utf8");
  assert.match(source, /Object\.freeze\(Object\.create\(null\)\)/);
  assert.match(source, /jsglobals: noJavaScriptGlobals/);
  assert.doesNotMatch(source, /loadPackagesFromImports/);
  assert.doesNotMatch(source, /micropip\.install/);
  assert.doesNotMatch(source, /mountNativeFS|mountNodeFS/);
  for (const blockedModule of ["js", "pyodide", "micropip", "socket"]) {
    assert.match(source, new RegExp(`"${blockedModule}"`));
  }
});

test("worker source retains hard request and output ceilings", async () => {
  const source = await readFile(workerPath, "utf8");
  assert.match(source, /const MAX_FILES = 8;/);
  assert.match(source, /const MAX_FILE_BYTES = 32_000;/);
  assert.match(source, /const MAX_TOTAL_FILE_BYTES = 120_000;/);
  assert.match(source, /const MAX_ARGS = 16;/);
  assert.match(source, /const MAX_OUTPUT_BYTES = 256 \* 1024;/);
  assert.match(source, /new BoundedWriter\(MAX_OUTPUT_BYTES\)/);
  assert.match(source, /OUTPUT_LIMIT_EXCEEDED/);
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
