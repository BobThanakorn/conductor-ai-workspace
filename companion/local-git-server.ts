import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { approveAction, consumeApproval, requestApproval } from "./approval-store";
import {
  deleteWorkspacePaths,
  listWorkspace,
  readWorkspaceFile,
  runGit,
  runShell,
  writeWorkspaceFiles,
} from "./execution-plane";
import { normalizeRepositoryRelativePath } from "./workspace-path";

const PORT = Number(process.env.CONDUCTOR_COMPANION_PORT ?? 8765);
const HOST = process.env.CONDUCTOR_COMPANION_HOST ?? "127.0.0.1";
const ROOT = process.env.CONDUCTOR_WORKSPACE_ROOT ?? process.cwd();
const MAX_BODY_BYTES = 4_500_000;
const ALLOWED_ORIGINS = new Set(
  (process.env.CONDUCTOR_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
type JsonRecord = Record<string, unknown>;

function send(response: ServerResponse, status: number, body: JsonRecord) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Conductor-Approval",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
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
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Request body must be a JSON object.");
  return parsed as JsonRecord;
}

function normalizePaths(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.length > 64) {
    throw new Error("paths must contain repository-relative paths.");
  }
  return [...new Set(value.map((item) => {
    if (typeof item !== "string") throw new Error("paths must be strings.");
    return normalizeRepositoryRelativePath(item);
  }))];
}

function parseStatus(stdout: string) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
}

function approvalToken(request: IncomingMessage) {
  const value = request.headers["x-conductor-approval"];
  return Array.isArray(value) ? value[0] : value;
}

async function approvedBody(request: IncomingMessage, action: string) {
  const body = await readBody(request);
  consumeApproval(approvalToken(request), action, body);
  return body;
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  try {
    const origin = request.headers.origin;
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return send(response, 403, { ok: false, error: "Browser origin is not allowed by the companion." });
    }
    if (request.method === "OPTIONS") return send(response, 204, { ok: true });
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      const [top, branch] = await Promise.all([runGit(ROOT, ["rev-parse", "--show-toplevel"]), runGit(ROOT, ["branch", "--show-current"])]);
      const githubConfigured = Boolean(process.env.GITHUB_TOKEN?.trim());
      return send(response, 200, {
        ok: true,
        root: top.stdout.trim(),
        branch: branch.stdout.trim(),
        executionMode: process.env.CONDUCTOR_EXECUTION_MODE ?? "host-readonly",
        capabilities: [
          "filesystem",
          "terminal",
          "git-local",
          "git-remote",
          ...(githubConfigured ? ["github-repository", "github-pr"] : []),
        ],
        integrations: { github: githubConfigured },
      });
    }

    if (request.method === "POST" && url.pathname === "/approvals/request") {
      const body = await readBody(request);
      if (typeof body.action !== "string" || !body.input || typeof body.input !== "object") throw new Error("action and input are required.");
      return send(response, 200, { ok: true, ...requestApproval(body.action, body.input) });
    }
    if (request.method === "POST" && url.pathname === "/approvals/approve") {
      const body = await readBody(request);
      if (body.confirm !== true || typeof body.approvalId !== "string" || typeof body.digest !== "string") throw new Error("Explicit confirmation, approvalId, and digest are required.");
      return send(response, 200, { ok: true, ...approveAction(body.approvalId, body.digest) });
    }

    if (request.method === "GET" && url.pathname === "/fs/tree") {
      const requested = url.searchParams.get("path") ?? ".";
      const depth = Number(url.searchParams.get("depth") ?? 5);
      return send(response, 200, { ok: true, root: ROOT, entries: await listWorkspace(ROOT, requested, depth) });
    }
    if (request.method === "POST" && url.pathname === "/fs/read") {
      const body = await readBody(request);
      if (typeof body.path !== "string") throw new Error("path is required.");
      return send(response, 200, { ok: true, ...(await readWorkspaceFile(ROOT, body.path)) });
    }
    if (request.method === "POST" && url.pathname === "/fs/write") {
      const body = await approvedBody(request, "fs.write");
      return send(response, 200, { ok: true, written: await writeWorkspaceFiles(ROOT, body.files) });
    }
    if (request.method === "POST" && url.pathname === "/fs/delete") {
      const body = await approvedBody(request, "fs.delete");
      return send(response, 200, { ok: true, deleted: await deleteWorkspacePaths(ROOT, body.paths) });
    }
    if (request.method === "POST" && url.pathname === "/terminal/execute") {
      const body = await approvedBody(request, "terminal.execute");
      return send(response, 200, { ok: true, ...(await runShell(ROOT, body)) });
    }

    if (request.method === "GET" && url.pathname === "/git/status") {
      const [top, branch, head, status, remotes] = await Promise.all([
        runGit(ROOT, ["rev-parse", "--show-toplevel"]), runGit(ROOT, ["branch", "--show-current"]),
        runGit(ROOT, ["rev-parse", "--short=12", "HEAD"]), runGit(ROOT, ["status", "--short"]), runGit(ROOT, ["remote", "-v"]),
      ]);
      return send(response, 200, { ok: true, root: top.stdout.trim(), branch: branch.stdout.trim(), head: head.stdout.trim(), files: parseStatus(status.stdout), raw: status.stdout, remotes: remotes.stdout });
    }
    if (request.method === "POST" && url.pathname === "/git/diff") {
      const body = await readBody(request);
      const paths = Array.isArray(body.paths) && body.paths.length ? normalizePaths(body.paths) : [];
      const result = await runGit(ROOT, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", ...paths]);
      return send(response, 200, { ok: true, stdout: result.stdout, stderr: result.stderr });
    }
    if (request.method === "POST" && url.pathname === "/git/commit") {
      const body = await approvedBody(request, "git.commit");
      const paths = normalizePaths(body.paths);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message || message.length > 200) throw new Error("message must be 1 to 200 characters.");
      await runGit(ROOT, ["add", "--", ...paths]);
      const result = await runGit(ROOT, ["commit", "-m", message]);
      const head = await runGit(ROOT, ["rev-parse", "--short=12", "HEAD"]);
      return send(response, 200, { ok: true, head: head.stdout.trim(), stdout: result.stdout, stderr: result.stderr });
    }
    if (request.method === "POST" && url.pathname === "/git/action") {
      const body = await approvedBody(request, "git.remote");
      const operation = typeof body.operation === "string" ? body.operation : "";
      const allowed = new Set(["pull", "push", "fetch", "checkout", "branch", "merge"]);
      if (!allowed.has(operation)) throw new Error("Unsupported Git operation.");
      const args = Array.isArray(body.args) ? body.args.map((item) => {
        if (typeof item !== "string" || item.length > 256 || item.includes("\0")) throw new Error("Invalid Git argument.");
        return item;
      }) : [];
      const result = await runGit(ROOT, [operation, ...args], 120_000);
      return send(response, 200, { ok: true, stdout: result.stdout, stderr: result.stderr });
    }
    if (request.method === "POST" && url.pathname === "/provider/github/pull-request") {
      const body = await approvedBody(request, "github.pull-request");
      const token = process.env.GITHUB_TOKEN?.trim();
      if (!token) throw new Error("GITHUB_TOKEN is not configured in the companion environment.");
      const repository = typeof body.repository === "string" ? body.repository : "";
      const [owner, repo, extra] = repository.split("/");
      if (!owner || !repo || extra || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repository must be owner/name.");
      const payload = { title: body.title, body: body.body ?? "", head: body.head, base: body.base };
      if ([payload.title, payload.head, payload.base].some((value) => typeof value !== "string" || !value.trim())) throw new Error("title, head, and base are required.");
      const githubResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Conductor-Companion", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await githubResponse.json() as Record<string, unknown>;
      if (!githubResponse.ok) throw new Error(typeof result.message === "string" ? result.message : "GitHub pull request creation failed.");
      return send(response, 200, { ok: true, number: result.number, url: result.html_url });
    }
    if (request.method === "POST" && url.pathname === "/provider/github/repository") {
      const body = await approvedBody(request, "github.create-repository");
      const token = process.env.GITHUB_TOKEN?.trim();
      if (!token) throw new Error("GITHUB_TOKEN is not configured in the companion environment.");
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const description = typeof body.description === "string" ? body.description.trim().slice(0, 1_000) : "";
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) throw new Error("name must be a valid GitHub repository name.");
      const githubResponse = await fetch("https://api.github.com/user/repos", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Conductor-Companion", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, private: body.private !== false, auto_init: body.autoInit === true }),
      });
      const result = await githubResponse.json() as Record<string, unknown>;
      if (!githubResponse.ok) throw new Error(typeof result.message === "string" ? result.message : "GitHub repository creation failed.");
      return send(response, 200, { ok: true, repository: result.full_name, url: result.html_url, cloneUrl: result.clone_url, defaultBranch: result.default_branch ?? "main" });
    }

    return send(response, 404, { ok: false, error: "Not found." });
  } catch (error) {
    return send(response, 400, { ok: false, error: error instanceof Error ? error.message : "Companion request failed." });
  }
}

createServer((request, response) => void handle(request, response)).listen(PORT, HOST, () => {
  process.stdout.write(`Conductor execution companion listening on http://${HOST}:${PORT}\nWorkspace: ${ROOT}\n`);
});
