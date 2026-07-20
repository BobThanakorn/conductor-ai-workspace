import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";

import { normalizeRepositoryRelativePath } from "./workspace-path";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.CONDUCTOR_COMPANION_PORT ?? 8765);
const ROOT = process.env.CONDUCTOR_WORKSPACE_ROOT ?? process.cwd();
const MAX_BODY_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 240_000;

type JsonRecord = Record<string, unknown>;

function send(response: ServerResponse, status: number, body: JsonRecord) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
  };
}

async function git(args: string[]) {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: ROOT,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: MAX_STREAM_BYTES,
    encoding: "utf8",
    env: gitEnv(),
    shell: false,
  });
  return { stdout, stderr };
}

async function readBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object.");
  }
  return parsed as JsonRecord;
}

function normalizePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new Error("paths must contain 1 to 64 repository-relative paths.");
  }
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new Error("paths must be strings.");
    unique.add(normalizeRepositoryRelativePath(item));
  }
  return Array.from(unique);
}

function parseStatus(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({
      code: line.slice(0, 2),
      path: line.slice(3),
    }));
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  try {
    if (request.method === "OPTIONS") {
      send(response, 204, { ok: true });
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      const top = await git(["rev-parse", "--show-toplevel"]);
      const branch = await git(["branch", "--show-current"]);
      send(response, 200, {
        ok: true,
        root: top.stdout.trim(),
        branch: branch.stdout.trim(),
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/git/status") {
      const [top, branch, head, status] = await Promise.all([
        git(["rev-parse", "--show-toplevel"]),
        git(["branch", "--show-current"]),
        git(["rev-parse", "--short=12", "HEAD"]),
        git(["status", "--short"]),
      ]);
      send(response, 200, {
        ok: true,
        root: top.stdout.trim(),
        branch: branch.stdout.trim(),
        head: head.stdout.trim(),
        files: parseStatus(status.stdout),
        raw: status.stdout,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/git/diff") {
      const body = await readBody(request);
      const paths = Array.isArray(body.paths) && body.paths.length ? normalizePaths(body.paths) : [];
      const result = await git([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        ...paths,
      ]);
      send(response, 200, { ok: true, stdout: result.stdout, stderr: result.stderr });
      return;
    }

    if (request.method === "POST" && url.pathname === "/git/commit") {
      const body = await readBody(request);
      if (body.confirm !== true) throw new Error("confirm must be true.");
      const paths = normalizePaths(body.paths);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message || message.length > 200) {
        throw new Error("message must be 1 to 200 characters.");
      }
      await git(["add", "--", ...paths]);
      const result = await git(["commit", "-m", message]);
      const head = await git(["rev-parse", "--short=12", "HEAD"]);
      send(response, 200, {
        ok: true,
        head: head.stdout.trim(),
        stdout: result.stdout,
        stderr: result.stderr,
      });
      return;
    }

    send(response, 404, { ok: false, error: "Not found." });
  } catch (error) {
    send(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : "Companion request failed.",
    });
  }
}

createServer((request, response) => {
  void handle(request, response);
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`Conductor local Git companion listening on http://127.0.0.1:${PORT}\n`);
  process.stdout.write(`Workspace: ${ROOT}\n`);
});
