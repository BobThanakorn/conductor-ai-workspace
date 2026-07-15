export const PYTHON_RUNNER_PROTOCOL_VERSION = "python-runner.request.v1" as const;
export const PYTHON_RUNNER_WORKER_URL = "/python-runner.worker.mjs" as const;
export const PYTHON_BOOTSTRAP_TIMEOUT_MS = 30_000;
export const PYTHON_EXECUTION_TIMEOUT_MAX_MS = 8_000;

export const PYTHON_RUNNER_LIMITS = Object.freeze({
  maxFiles: 8,
  maxFileBytes: 32_000,
  maxTotalFileBytes: 120_000,
  maxArgs: 16,
  maxArgCharacters: 256,
  maxTotalArgCharacters: 2_048,
  maxArgBytes: 4 * 1024,
  maxTotalArgBytes: 16 * 1024,
  maxOutputBytesPerStream: 256 * 1024,
});

export interface PythonSourceFile {
  readonly path: string;
  readonly content: string;
}

export interface PythonRunInput {
  readonly entrypoint: string;
  readonly files: readonly PythonSourceFile[];
  readonly args?: readonly string[];
}

export interface ValidatedPythonRunInput {
  readonly entrypoint: string;
  readonly files: readonly PythonSourceFile[];
  readonly args: readonly string[];
}

export interface PythonRunnerError {
  readonly code: string;
  readonly message: string;
}

export interface PythonRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly error: PythonRunnerError | null;
  readonly durationMs: number;
}

export interface PythonSandboxInput extends PythonRunInput {
  readonly timeoutMs?: number;
}

export interface PythonSandboxResult extends PythonRunResult {
  readonly timedOut: boolean;
}

export type PythonRunnerLifecyclePhase =
  | "booting"
  | "ready"
  | "accepted"
  | "running"
  | "finished"
  | "failed";

export interface PythonRunnerLifecycleEvent {
  readonly schemaVersion: "python-runner.event.v1";
  readonly type: "python.runner.lifecycle";
  readonly jobId: string | null;
  readonly phase: PythonRunnerLifecyclePhase;
  readonly error: PythonRunnerError | null;
}

export interface PythonRunnerOptions {
  /** Hard execution timeout; bootstrap has a separate fixed 30-second ceiling. */
  readonly timeoutMs?: number;
  readonly onLifecycle?: (event: PythonRunnerLifecycleEvent) => void;
}

interface ValidatedRunnerOptions {
  readonly timeoutMs: number;
  readonly onLifecycle?: (event: PythonRunnerLifecycleEvent) => void;
}

interface WorkerResultMessage {
  readonly schemaVersion: "python-runner.result.v1";
  readonly type: "python.runner.result";
  readonly jobId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly error: PythonRunnerError | null;
  readonly durationMs: number;
}

export class PythonRunnerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythonRunnerValidationError";
  }
}

/**
 * Starts a fresh module worker for one Python job and always terminates it.
 * Invalid inputs reject with `PythonRunnerValidationError`; runtime failures are
 * returned as structured `PythonRunResult.error` values.
 */
export async function runPythonIsolated(
  input: PythonRunInput,
  options: PythonRunnerOptions = {},
): Promise<PythonRunResult> {
  const request = validatePythonRunInput(input);
  const validatedOptions = validatePythonRunnerOptions(options);
  const startedAt = monotonicNow();

  if (typeof Worker !== "function") {
    return runtimeFailure(
      "WORKER_UNAVAILABLE",
      "Dedicated Web Workers are unavailable in this environment.",
      startedAt,
    );
  }
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    return runtimeFailure(
      "CRYPTO_UNAVAILABLE",
      "A secure browser random UUID source is required.",
      startedAt,
    );
  }

  const jobId = globalThis.crypto.randomUUID();
  let worker: Worker;
  try {
    worker = new Worker(PYTHON_RUNNER_WORKER_URL, {
      type: "module",
      name: "isolated-python-runner",
    });
  } catch (error) {
    return runtimeFailure(
      "WORKER_START_FAILED",
      error instanceof Error ? error.message : "Unable to start the Python worker.",
      startedAt,
    );
  }

  return new Promise<PythonRunResult>((resolve) => {
    let settled = false;
    let executionTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: PythonRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(bootstrapTimer);
      if (executionTimer !== undefined) clearTimeout(executionTimer);
      worker.terminate();
      resolve(result);
    };

    const bootstrapTimer = setTimeout(() => {
      finish(
        runtimeFailure(
          "BOOTSTRAP_TIMEOUT",
          "Pyodide did not become execution-ready within 30 seconds.",
          startedAt,
          124,
        ),
      );
    }, PYTHON_BOOTSTRAP_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<unknown>): void => {
      try {
        if (isLifecycleCandidate(event.data)) {
          const lifecycle = parseLifecycleMessage(event.data);
          if (lifecycle.jobId !== null && lifecycle.jobId !== jobId) {
            throw new PythonRunnerValidationError("Worker lifecycle jobId mismatch.");
          }
          try {
            validatedOptions.onLifecycle?.(lifecycle);
          } catch {
            // Consumer callbacks cannot alter worker lifecycle handling.
          }

          if (lifecycle.phase === "running") {
            if (executionTimer !== undefined) {
              throw new PythonRunnerValidationError("Worker emitted duplicate running events.");
            }
            clearTimeout(bootstrapTimer);
            executionTimer = setTimeout(() => {
              finish(
                runtimeFailure(
                  "EXECUTION_TIMEOUT",
                  `Python execution exceeded ${validatedOptions.timeoutMs} ms.`,
                  startedAt,
                  124,
                ),
              );
            }, validatedOptions.timeoutMs);
          } else if (lifecycle.phase === "failed" && lifecycle.error !== null) {
            finish({
              stdout: "",
              stderr: "",
              exitCode: 1,
              error: lifecycle.error,
              durationMs: elapsedSince(startedAt),
            });
          }
          return;
        }

        const result = parseWorkerResult(event.data);
        if (result.jobId !== jobId) {
          throw new PythonRunnerValidationError("Worker result jobId mismatch.");
        }
        finish({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          error: result.error,
          durationMs: result.durationMs,
        });
      } catch (error) {
        finish(
          runtimeFailure(
            "PROTOCOL_ERROR",
            error instanceof Error ? error.message : "Malformed worker message.",
            startedAt,
          ),
        );
      }
    };

    worker.onerror = (event: ErrorEvent): void => {
      event.preventDefault();
      finish(
        runtimeFailure(
          "WORKER_ERROR",
          event.message || "The isolated Python worker failed.",
          startedAt,
        ),
      );
    };

    worker.onmessageerror = (): void => {
      finish(
        runtimeFailure(
          "PROTOCOL_ERROR",
          "The browser could not deserialize a Python worker message.",
          startedAt,
        ),
      );
    };

    worker.postMessage({
      schemaVersion: PYTHON_RUNNER_PROTOCOL_VERSION,
      type: "python.run",
      jobId,
      entrypoint: request.entrypoint,
      files: request.files,
      args: request.args,
    });
  });
}

/** Compatibility surface consumed by the workspace UI. */
export async function runPythonSandbox({
  files,
  entrypoint,
  args,
  timeoutMs,
}: PythonSandboxInput): Promise<PythonSandboxResult> {
  const result = await runPythonIsolated(
    {
      files,
      entrypoint,
      ...(args === undefined ? {} : { args }),
    },
    timeoutMs === undefined ? {} : { timeoutMs },
  );
  return {
    ...result,
    timedOut: result.error?.code === "EXECUTION_TIMEOUT",
  };
}

export function validatePythonRunInput(value: unknown): ValidatedPythonRunInput {
  assertPlainObject(value, "Python run input");
  assertExactKeys(value, ["entrypoint", "files"], ["args"]);
  const entrypoint = validatePythonPath(value.entrypoint, "entrypoint");

  if (
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > PYTHON_RUNNER_LIMITS.maxFiles
  ) {
    throw new PythonRunnerValidationError(
      `files must contain between 1 and ${PYTHON_RUNNER_LIMITS.maxFiles} entries.`,
    );
  }

  let totalFileBytes = 0;
  const seenPaths = new Set<string>();
  const files = value.files.map((candidate, index): PythonSourceFile => {
    assertPlainObject(candidate, `files[${index}]`);
    assertExactKeys(candidate, ["path", "content"]);
    const filePath = validatePythonPath(candidate.path, `files[${index}].path`);
    if (seenPaths.has(filePath)) {
      throw new PythonRunnerValidationError(`Duplicate file path: ${filePath}`);
    }
    seenPaths.add(filePath);
    if (typeof candidate.content !== "string") {
      throw new PythonRunnerValidationError(`files[${index}].content must be a string.`);
    }
    const byteLength = utf8Bytes(candidate.content);
    if (byteLength > PYTHON_RUNNER_LIMITS.maxFileBytes) {
      throw new PythonRunnerValidationError(`${filePath} exceeds the per-file byte limit.`);
    }
    totalFileBytes += byteLength;
    if (totalFileBytes > PYTHON_RUNNER_LIMITS.maxTotalFileBytes) {
      throw new PythonRunnerValidationError("Files exceed the total byte limit.");
    }
    return Object.freeze({ path: filePath, content: candidate.content });
  });

  if (!seenPaths.has(entrypoint)) {
    throw new PythonRunnerValidationError("entrypoint must identify one supplied file.");
  }

  const rawArgs = value.args ?? [];
  if (!Array.isArray(rawArgs) || rawArgs.length > PYTHON_RUNNER_LIMITS.maxArgs) {
    throw new PythonRunnerValidationError(
      `args must contain at most ${PYTHON_RUNNER_LIMITS.maxArgs} strings.`,
    );
  }
  let totalArgBytes = 0;
  let totalArgCharacters = 0;
  const args = rawArgs.map((argument, index): string => {
    if (typeof argument !== "string" || /[\u0000-\u001F\u007F]/.test(argument)) {
      throw new PythonRunnerValidationError(`args[${index}] must be a control-free string.`);
    }
    if (argument.length > PYTHON_RUNNER_LIMITS.maxArgCharacters) {
      throw new PythonRunnerValidationError(`args[${index}] exceeds the character limit.`);
    }
    totalArgCharacters += argument.length;
    if (totalArgCharacters > PYTHON_RUNNER_LIMITS.maxTotalArgCharacters) {
      throw new PythonRunnerValidationError("args exceed the total character limit.");
    }
    const byteLength = utf8Bytes(argument);
    if (byteLength > PYTHON_RUNNER_LIMITS.maxArgBytes) {
      throw new PythonRunnerValidationError(`args[${index}] exceeds the byte limit.`);
    }
    totalArgBytes += byteLength;
    if (totalArgBytes > PYTHON_RUNNER_LIMITS.maxTotalArgBytes) {
      throw new PythonRunnerValidationError("args exceed the total byte limit.");
    }
    return argument;
  });

  return Object.freeze({
    entrypoint,
    files: Object.freeze(files),
    args: Object.freeze(args),
  });
}

export function validatePythonRunnerOptions(value: unknown): ValidatedRunnerOptions {
  assertPlainObject(value, "Python runner options");
  assertExactKeys(value, [], ["timeoutMs", "onLifecycle"]);
  const timeoutMs = value.timeoutMs ?? PYTHON_EXECUTION_TIMEOUT_MAX_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > PYTHON_EXECUTION_TIMEOUT_MAX_MS
  ) {
    throw new PythonRunnerValidationError(
      `timeoutMs must be an integer from 100 to ${PYTHON_EXECUTION_TIMEOUT_MAX_MS}.`,
    );
  }
  if (value.onLifecycle !== undefined && typeof value.onLifecycle !== "function") {
    throw new PythonRunnerValidationError("onLifecycle must be a function.");
  }
  return {
    timeoutMs,
    ...(value.onLifecycle === undefined
      ? {}
      : {
          onLifecycle: value.onLifecycle as (event: PythonRunnerLifecycleEvent) => void,
        }),
  };
}

function parseLifecycleMessage(value: unknown): PythonRunnerLifecycleEvent {
  assertPlainObject(value, "Worker lifecycle message");
  assertExactKeys(value, ["schemaVersion", "type", "jobId", "phase", "error"]);
  if (value.schemaVersion !== "python-runner.event.v1" || value.type !== "python.runner.lifecycle") {
    throw new PythonRunnerValidationError("Unsupported worker lifecycle schema.");
  }
  if (value.jobId !== null && !isJobId(value.jobId)) {
    throw new PythonRunnerValidationError("Invalid lifecycle jobId.");
  }
  if (!isLifecyclePhase(value.phase)) {
    throw new PythonRunnerValidationError("Invalid lifecycle phase.");
  }
  return {
    schemaVersion: value.schemaVersion,
    type: value.type,
    jobId: value.jobId,
    phase: value.phase,
    error: parseRunnerError(value.error),
  };
}

function parseWorkerResult(value: unknown): WorkerResultMessage {
  assertPlainObject(value, "Worker result message");
  assertExactKeys(value, [
    "schemaVersion",
    "type",
    "jobId",
    "stdout",
    "stderr",
    "exitCode",
    "error",
    "durationMs",
  ]);
  if (value.schemaVersion !== "python-runner.result.v1" || value.type !== "python.runner.result") {
    throw new PythonRunnerValidationError("Unsupported worker result schema.");
  }
  if (!isJobId(value.jobId)) throw new PythonRunnerValidationError("Invalid result jobId.");
  if (
    typeof value.stdout !== "string" ||
    utf8Bytes(value.stdout) > PYTHON_RUNNER_LIMITS.maxOutputBytesPerStream ||
    typeof value.stderr !== "string" ||
    utf8Bytes(value.stderr) > PYTHON_RUNNER_LIMITS.maxOutputBytesPerStream
  ) {
    throw new PythonRunnerValidationError("Worker output exceeds its protocol bounds.");
  }
  if (
    typeof value.exitCode !== "number" ||
    !Number.isInteger(value.exitCode) ||
    value.exitCode < 0 ||
    value.exitCode > 255
  ) {
    throw new PythonRunnerValidationError("Invalid Python exit code.");
  }
  if (
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    value.durationMs > PYTHON_BOOTSTRAP_TIMEOUT_MS + PYTHON_EXECUTION_TIMEOUT_MAX_MS + 2_000
  ) {
    throw new PythonRunnerValidationError("Invalid worker duration.");
  }
  return {
    schemaVersion: value.schemaVersion,
    type: value.type,
    jobId: value.jobId,
    stdout: value.stdout,
    stderr: value.stderr,
    exitCode: value.exitCode,
    error: parseRunnerError(value.error),
    durationMs: value.durationMs,
  };
}

function parseRunnerError(value: unknown): PythonRunnerError | null {
  if (value === null) return null;
  assertPlainObject(value, "Worker error");
  assertExactKeys(value, ["code", "message"]);
  if (
    typeof value.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ||
    typeof value.message !== "string" ||
    value.message.length > 2_000
  ) {
    throw new PythonRunnerValidationError("Invalid worker error payload.");
  }
  return { code: value.code, message: value.message };
}

function validatePythonPath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new PythonRunnerValidationError(`${field} must be a relative .py path.`);
  }
  const segments = value.split("/");
  if (
    !value.endsWith(".py") ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(segment),
    )
  ) {
    throw new PythonRunnerValidationError(`${field} contains an unsafe path segment.`);
  }
  return value;
}

function assertPlainObject(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new PythonRunnerValidationError(`${field} must be a plain object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new PythonRunnerValidationError(`Unexpected field: ${key}`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      throw new PythonRunnerValidationError(`Missing required field: ${key}`);
    }
  }
}

function isLifecycleCandidate(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "python.runner.lifecycle"
  );
}

function isLifecyclePhase(value: unknown): value is PythonRunnerLifecyclePhase {
  return (
    value === "booting" ||
    value === "ready" ||
    value === "accepted" ||
    value === "running" ||
    value === "finished" ||
    value === "failed"
  );
}

function isJobId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function runtimeFailure(
  code: string,
  message: string,
  startedAt: number,
  exitCode = 1,
): PythonRunResult {
  return {
    stdout: "",
    stderr: "",
    exitCode,
    error: { code, message: message.slice(0, 2_000) },
    durationMs: elapsedSince(startedAt),
  };
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(monotonicNow() - startedAt));
}
