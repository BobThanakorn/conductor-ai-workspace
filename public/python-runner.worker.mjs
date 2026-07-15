import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.2/full/pyodide.mjs";

const REQUEST_SCHEMA = "python-runner.request.v1";
const EVENT_SCHEMA = "python-runner.event.v1";
const RESULT_SCHEMA = "python-runner.result.v1";
const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v314.0.2/full/";

const MAX_FILES = 8;
const MAX_FILE_BYTES = 32_000;
const MAX_TOTAL_FILE_BYTES = 120_000;
const MAX_ARGS = 16;
const MAX_ARG_CHARACTERS = 256;
const MAX_TOTAL_ARG_CHARACTERS = 2_048;
const MAX_ARG_BYTES = 4 * 1024;
const MAX_TOTAL_ARG_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });
const closeWorker = globalThis.close.bind(globalThis);

let activeJobId = null;
let spent = false;

postLifecycle(null, "booting", null);

const readyPromise = initializeRuntime().catch((error) => {
  const normalized = normalizeError(error, "BOOTSTRAP_ERROR");
  postLifecycle(null, "failed", normalized);
  return { pyodide: null, error: normalized };
});

globalThis.addEventListener("message", (event) => {
  void handleMessage(event.data);
});

async function initializeRuntime() {
  const noJavaScriptGlobals = Object.freeze(Object.create(null));
  const pyodide = await loadPyodide({
    indexURL: PYODIDE_INDEX,
    jsglobals: noJavaScriptGlobals,
    stdin: () => null,
    stdout: () => {},
    stderr: () => {},
  });

  pyodide.setStdin({ error: true });
  installPythonGuards(pyodide);
  disableBrowserCapabilities();
  postLifecycle(null, "ready", null);
  return { pyodide, error: null };
}

async function handleMessage(rawRequest) {
  let request;
  try {
    request = validateRequest(rawRequest);
  } catch (error) {
    postResult({
      jobId: safeJobId(rawRequest),
      stdout: "",
      stderr: "",
      exitCode: 1,
      error: normalizeError(error, "INVALID_REQUEST"),
      durationMs: 0,
    });
    return;
  }

  if (activeJobId !== null) {
    postResult({
      jobId: request.jobId,
      stdout: "",
      stderr: "",
      exitCode: 1,
      error: { code: "BUSY", message: "The worker already has an active job." },
      durationMs: 0,
    });
    return;
  }
  if (spent) {
    postResult({
      jobId: request.jobId,
      stdout: "",
      stderr: "",
      exitCode: 1,
      error: {
        code: "WORKER_SPENT",
        message: "This isolated worker has already processed one job.",
      },
      durationMs: 0,
    });
    return;
  }

  activeJobId = request.jobId;
  spent = true;
  const startedAt = performance.now();
  postLifecycle(request.jobId, "accepted", null);

  const ready = await readyPromise;
  if (ready.pyodide === null) {
    postResult({
      jobId: request.jobId,
      stdout: "",
      stderr: "",
      exitCode: 1,
      error: ready.error,
      durationMs: elapsed(startedAt),
    });
    activeJobId = null;
    scheduleClose();
    return;
  }

  const result = await executeJob(ready.pyodide, request, startedAt);
  postResult(result);
  postLifecycle(request.jobId, "finished", result.error);
  activeJobId = null;
  scheduleClose();
}

async function executeJob(pyodide, request, startedAt) {
  const stdout = new BoundedWriter(MAX_OUTPUT_BYTES);
  const stderr = new BoundedWriter(MAX_OUTPUT_BYTES);
  const jobRoot = "/workspace/job";
  let globals = null;
  let pythonArgs = null;
  let pythonResult = null;

  try {
    removeTree(pyodide.FS, jobRoot);
    pyodide.FS.mkdirTree(jobRoot);
    for (const file of request.files) {
      const absolutePath = `${jobRoot}/${file.path}`;
      const directory = absolutePath.slice(0, absolutePath.lastIndexOf("/"));
      pyodide.FS.mkdirTree(directory);
      pyodide.FS.writeFile(absolutePath, file.content, { encoding: "utf8" });
    }
    pyodide.FS.chdir(jobRoot);
    pyodide.setStdout(stdout);
    pyodide.setStderr(stderr);
    pyodide.setStdin({ error: true });

    const dict = pyodide.globals.get("dict");
    globals = dict();
    dict.destroy();
    pythonArgs = pyodide.toPy(request.args);
    globals.set("__runner_entrypoint", request.entrypoint);
    globals.set("__runner_root", jobRoot);
    globals.set("__runner_args", pythonArgs);

    // The parent starts the hard execution timer only after this message.
    postLifecycle(request.jobId, "running", null);
    pythonResult = await pyodide.runPythonAsync(PYTHON_ENTRYPOINT_WRAPPER, {
      globals,
      filename: "<isolated-python-runner>",
    });
    const [exitCode, errorCode, errorMessage] = pythonResult.toJs();

    if (stdout.exceeded || stderr.exceeded) {
      return resultFor(
        request.jobId,
        stdout,
        stderr,
        1,
        {
          code: "OUTPUT_LIMIT_EXCEEDED",
          message: "Python output exceeded the 256 KiB per-stream limit.",
        },
        startedAt,
      );
    }

    return resultFor(
      request.jobId,
      stdout,
      stderr,
      normalizeExitCode(exitCode),
      errorCode === null
        ? null
        : {
            code: String(errorCode).slice(0, 64),
            message: String(errorMessage).slice(0, 2_000),
          },
      startedAt,
    );
  } catch (error) {
    const outputError = stdout.exceeded || stderr.exceeded;
    return resultFor(
      request.jobId,
      stdout,
      stderr,
      1,
      outputError
        ? {
            code: "OUTPUT_LIMIT_EXCEEDED",
            message: "Python output exceeded the 256 KiB per-stream limit.",
          }
        : normalizeError(error, "PYTHON_RUNTIME_ERROR"),
      startedAt,
    );
  } finally {
    try {
      pyodide.FS.chdir("/");
      removeTree(pyodide.FS, jobRoot);
    } catch {
      // The entire worker is terminated after this job; no state is reused.
    }
    pythonResult?.destroy?.();
    pythonArgs?.destroy?.();
    globals?.destroy?.();
  }
}

const PYTHON_ENTRYPOINT_WRAPPER = String.raw`
import os as __runner_os
import runpy as __runner_runpy
import sys as __runner_sys
import traceback as __runner_traceback

__runner_exit_code = 0
__runner_error_code = None
__runner_error_message = None
__runner_previous_argv = list(__runner_sys.argv)
__runner_previous_path = list(__runner_sys.path)
__runner_previous_cwd = __runner_os.getcwd()

try:
    __runner_os.chdir(__runner_root)
    __runner_sys.argv = [__runner_entrypoint, *list(__runner_args)]
    __runner_sys.path.insert(0, __runner_root)
    __runner_runpy.run_path(__runner_entrypoint, run_name="__main__")
except SystemExit as __runner_system_exit:
    __runner_code = __runner_system_exit.code
    if __runner_code is None:
        __runner_exit_code = 0
    elif isinstance(__runner_code, int):
        __runner_exit_code = max(0, min(255, __runner_code))
    else:
        print(str(__runner_code), file=__runner_sys.stderr)
        __runner_exit_code = 1
except BaseException as __runner_exception:
    __runner_exit_code = 1
    __runner_error_code = "PYTHON_EXCEPTION"
    __runner_error_message = f"{type(__runner_exception).__name__}: {__runner_exception}"
    __runner_traceback.print_exc(file=__runner_sys.stderr)
finally:
    __runner_sys.argv = __runner_previous_argv
    __runner_sys.path[:] = __runner_previous_path
    try:
        __runner_os.chdir(__runner_previous_cwd)
    except BaseException:
        pass

[__runner_exit_code, __runner_error_code, __runner_error_message]
`;

function installPythonGuards(pyodide) {
  pyodide.runPython(String.raw`
import sys as _runner_guard_sys

_RUNNER_BLOCKED_MODULES = (
    "js",
    "micropip",
    "pyodide",
    "pyodide_js",
    "socket",
    "urllib.request",
    "http.client",
    "webbrowser",
)

def _runner_module_is_blocked(name):
    return any(name == blocked or name.startswith(blocked + ".") for blocked in _RUNNER_BLOCKED_MODULES)

def _runner_audit_hook(event, args):
    if event == "import" and args and _runner_module_is_blocked(str(args[0])):
        raise PermissionError(f"Module {args[0]!r} is disabled in the isolated runner")
    if event.startswith("socket."):
        raise PermissionError("Network access is disabled in the isolated runner")

class _RunnerBlockedModuleFinder:
    def find_spec(self, fullname, path=None, target=None):
        if _runner_module_is_blocked(fullname):
            raise ImportError(f"Module {fullname!r} is disabled in the isolated runner")
        return None

for _runner_name in tuple(_runner_guard_sys.modules):
    if _runner_module_is_blocked(_runner_name):
        _runner_guard_sys.modules.pop(_runner_name, None)

_runner_guard_sys.meta_path.insert(0, _RunnerBlockedModuleFinder())
_runner_guard_sys.addaudithook(_runner_audit_hook)
`);
}

function disableBrowserCapabilities() {
  const blocked = () => {
    throw new Error("Network and host storage are disabled in the isolated Python worker.");
  };
  for (const name of [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "WebTransport",
    "RTCPeerConnection",
    "Worker",
    "SharedWorker",
    "BroadcastChannel",
    "importScripts",
    "indexedDB",
    "caches",
  ]) {
    try {
      Object.defineProperty(globalThis, name, {
        value: blocked,
        writable: false,
        configurable: false,
      });
    } catch {
      // `jsglobals` is empty, so an unshadowable host property is not exposed to Python.
    }
  }
  try {
    Object.defineProperty(globalThis.navigator, "storage", {
      value: undefined,
      writable: false,
      configurable: false,
    });
  } catch {
    // WorkerNavigator implementations differ; Python has no navigator bridge.
  }
}

class BoundedWriter {
  constructor(limit) {
    this.limit = limit;
    this.length = 0;
    this.chunks = [];
    this.exceeded = false;
    this.isatty = false;
  }

  write(buffer) {
    if (!(buffer instanceof Uint8Array)) {
      throw new TypeError("Pyodide stream writer expected bytes.");
    }
    if (this.length + buffer.byteLength > this.limit) {
      this.exceeded = true;
      throw new Error("PYTHON_OUTPUT_LIMIT_EXCEEDED");
    }
    this.chunks.push(buffer.slice());
    this.length += buffer.byteLength;
    return buffer.byteLength;
  }

  text() {
    const combined = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return decoder.decode(combined);
  }
}

function validateRequest(value) {
  assertPlainObject(value, "Request");
  assertExactKeys(value, ["schemaVersion", "type", "jobId", "entrypoint", "files", "args"]);
  if (value.schemaVersion !== REQUEST_SCHEMA || value.type !== "python.run") {
    throw new Error("Unsupported Python runner request schema.");
  }
  if (!isJobId(value.jobId)) throw new Error("Invalid jobId.");
  const entrypoint = validatePythonPath(value.entrypoint, "entrypoint");
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_FILES) {
    throw new Error(`files must contain between 1 and ${MAX_FILES} entries.`);
  }

  let totalFileBytes = 0;
  const seenPaths = new Set();
  const files = value.files.map((file, index) => {
    assertPlainObject(file, `files[${index}]`);
    assertExactKeys(file, ["path", "content"]);
    const filePath = validatePythonPath(file.path, `files[${index}].path`);
    if (seenPaths.has(filePath)) throw new Error(`Duplicate file path: ${filePath}`);
    seenPaths.add(filePath);
    if (typeof file.content !== "string") throw new Error(`files[${index}].content must be a string.`);
    const size = encoder.encode(file.content).byteLength;
    if (size > MAX_FILE_BYTES) throw new Error(`File ${filePath} exceeds the per-file byte limit.`);
    totalFileBytes += size;
    if (totalFileBytes > MAX_TOTAL_FILE_BYTES) throw new Error("Files exceed the total byte limit.");
    return { path: filePath, content: file.content };
  });
  if (!seenPaths.has(entrypoint)) throw new Error("entrypoint must identify one supplied file.");

  if (!Array.isArray(value.args) || value.args.length > MAX_ARGS) {
    throw new Error(`args must contain at most ${MAX_ARGS} strings.`);
  }
  let totalArgBytes = 0;
  let totalArgCharacters = 0;
  const args = value.args.map((argument, index) => {
    if (typeof argument !== "string" || /[\u0000-\u001F\u007F]/.test(argument)) {
      throw new Error(`args[${index}] must be a control-free string.`);
    }
    if (argument.length > MAX_ARG_CHARACTERS) {
      throw new Error(`args[${index}] exceeds the character limit.`);
    }
    totalArgCharacters += argument.length;
    if (totalArgCharacters > MAX_TOTAL_ARG_CHARACTERS) throw new Error("args exceed the total character limit.");
    const size = encoder.encode(argument).byteLength;
    if (size > MAX_ARG_BYTES) throw new Error(`args[${index}] exceeds the byte limit.`);
    totalArgBytes += size;
    if (totalArgBytes > MAX_TOTAL_ARG_BYTES) throw new Error("args exceed the total byte limit.");
    return argument;
  });

  return { jobId: value.jobId, entrypoint, files, args };
}

function validatePythonPath(value, field) {
  if (typeof value !== "string" || value.length < 1 || value.length > 200 || value.includes("\0")) {
    throw new Error(`${field} is invalid.`);
  }
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`${field} must be a forward-slash relative path.`);
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
    throw new Error(`${field} must contain safe relative .py path segments.`);
  }
  return value;
}

function removeTree(FS, root) {
  try {
    const stat = FS.stat(root);
    if (!FS.isDir(stat.mode)) {
      FS.unlink(root);
      return;
    }
    for (const entry of FS.readdir(root)) {
      if (entry === "." || entry === "..") continue;
      removeTree(FS, `${root}/${entry}`);
    }
    FS.rmdir(root);
  } catch (error) {
    if (error?.errno !== 44) throw error;
  }
}

function resultFor(jobId, stdout, stderr, exitCode, error, startedAt) {
  return {
    jobId,
    stdout: stdout.text(),
    stderr: stderr.text(),
    exitCode,
    error,
    durationMs: elapsed(startedAt),
  };
}

function postLifecycle(jobId, phase, error) {
  globalThis.postMessage({
    schemaVersion: EVENT_SCHEMA,
    type: "python.runner.lifecycle",
    jobId,
    phase,
    error,
  });
}

function postResult(result) {
  globalThis.postMessage({
    schemaVersion: RESULT_SCHEMA,
    type: "python.runner.result",
    jobId: result.jobId,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    error: result.error,
    durationMs: result.durationMs,
  });
}

function scheduleClose() {
  globalThis.setTimeout(closeWorker, 0);
}

function assertPlainObject(value, field) {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${field} must be a plain object.`);
  }
}

function assertExactKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    throw new Error("Message contains missing or unexpected fields.");
  }
}

function isJobId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function safeJobId(value) {
  return value && isJobId(value.jobId) ? value.jobId : "invalid-job";
}

function normalizeExitCode(value) {
  return Number.isInteger(value) && value >= 0 && value <= 255 ? value : 1;
}

function normalizeError(error, fallbackCode) {
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message.slice(0, 2_000) : "Unknown runner error.",
  };
}

function elapsed(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
