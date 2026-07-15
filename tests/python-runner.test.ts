import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PYTHON_EXECUTION_TIMEOUT_MAX_MS,
  PYTHON_RUNNER_LIMITS,
  PythonRunnerValidationError,
  runPythonSandbox,
  validatePythonRunInput,
  validatePythonRunnerOptions,
} from "../lib/python-runner.ts";

test("validates and normalizes a bounded multi-file Python request", () => {
  const request = validatePythonRunInput({
    entrypoint: "src/main.py",
    files: [
      { path: "src/main.py", content: "from helper import answer\nprint(answer)" },
      { path: "src/helper.py", content: "answer = 42" },
    ],
    args: ["--format", "text"],
  });

  assert.equal(request.entrypoint, "src/main.py");
  assert.equal(request.files.length, 2);
  assert.deepEqual(request.args, ["--format", "text"]);
  assert.ok(Object.isFrozen(request));
});

test("rejects extra fields, unsafe paths, duplicates, and missing entrypoints", () => {
  const main = { path: "main.py", content: "print('ok')" };
  assert.throws(
    () => validatePythonRunInput({ entrypoint: "main.py", files: [main], extra: true }),
    PythonRunnerValidationError,
  );
  for (const unsafe of ["../main.py", "/main.py", "C:\\main.py", "main.txt", "a//main.py"]) {
    assert.throws(
      () => validatePythonRunInput({ entrypoint: unsafe, files: [{ ...main, path: unsafe }] }),
      PythonRunnerValidationError,
    );
  }
  assert.throws(
    () => validatePythonRunInput({ entrypoint: "main.py", files: [main, main] }),
    /Duplicate/,
  );
  assert.throws(
    () =>
      validatePythonRunInput({
        entrypoint: "main.py",
        files: [{ path: "helper.py", content: "pass" }],
      }),
    /entrypoint must identify/,
  );
});

test("enforces file count and UTF-8 byte ceilings", () => {
  const tooMany = Array.from(
    { length: PYTHON_RUNNER_LIMITS.maxFiles + 1 },
    (_, index) => ({ path: `file_${index}.py`, content: "pass" }),
  );
  assert.throws(
    () => validatePythonRunInput({ entrypoint: "file_0.py", files: tooMany }),
    /files must contain/,
  );

  assert.throws(
    () =>
      validatePythonRunInput({
        entrypoint: "main.py",
        files: [{ path: "main.py", content: "é".repeat(16_385) }],
      }),
    /per-file byte limit/,
  );

  const totalOverflow = Array.from({ length: 4 }, (_, index) => ({
    path: index === 0 ? "main.py" : `file_${index}.py`,
    content: "x".repeat(31_000),
  }));
  assert.throws(
    () => validatePythonRunInput({ entrypoint: "main.py", files: totalOverflow }),
    /total byte limit/,
  );
});

test("enforces argument and execution timeout bounds", () => {
  const base = {
    entrypoint: "main.py",
    files: [{ path: "main.py", content: "pass" }],
  };
  assert.throws(
    () =>
      validatePythonRunInput({
        ...base,
        args: Array.from({ length: PYTHON_RUNNER_LIMITS.maxArgs + 1 }, () => "arg"),
      }),
    /args must contain/,
  );
  assert.throws(
    () => validatePythonRunInput({ ...base, args: ["x".repeat(257)] }),
    /character limit/,
  );
  assert.throws(
    () => validatePythonRunInput({ ...base, args: ["line\nbreak"] }),
    /control-free/,
  );
  assert.equal(
    validatePythonRunInput({ ...base, args: ["😀".repeat(128)] }).args[0]?.length,
    256,
  );

  assert.equal(validatePythonRunnerOptions({}).timeoutMs, PYTHON_EXECUTION_TIMEOUT_MAX_MS);
  assert.equal(validatePythonRunnerOptions({ timeoutMs: 250 }).timeoutMs, 250);
  assert.throws(
    () => validatePythonRunnerOptions({ timeoutMs: PYTHON_EXECUTION_TIMEOUT_MAX_MS + 1 }),
    /timeoutMs/,
  );
  assert.throws(() => validatePythonRunnerOptions({ timeoutMs: 99 }), /timeoutMs/);
  assert.throws(
    () => validatePythonRunnerOptions({ timeoutMs: 100, extra: true }),
    /Unexpected field/,
  );
});

test("compatibility wrapper returns the UI result contract", async () => {
  const result = await runPythonSandbox({
    entrypoint: "main.py",
    files: [{ path: "main.py", content: "print('ok')" }],
    timeoutMs: 100,
  });
  assert.equal(typeof result.stdout, "string");
  assert.equal(typeof result.stderr, "string");
  assert.equal(typeof result.exitCode, "number");
  assert.equal(typeof result.durationMs, "number");
  assert.equal(result.timedOut, result.error?.code === "EXECUTION_TIMEOUT");
});
