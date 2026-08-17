import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { approveAction, consumeApproval, requestApproval } from "./approval-store";
import {
  deleteWorkspacePaths,
  listWorkspace,
  readWorkspaceFile,
  runGit,
  runShell,
  runShellBatch,
  writeWorkspaceFiles,
} from "./execution-plane";
import { normalizeRepositoryRelativePath } from "./workspace-path";
import { validateContractBoundInput } from "./contract-binding";
import { invokeReadOnlyMcpTool } from "../lib/agent-tool-adapter";
import { normalizeAgentToolEvent, normalizeToolFailure, toolRequiresApproval } from "../lib/agent-tools";
import { buildRepositoryIndex, retrieveRepositoryContext } from "../lib/repository-index";
import {
  listTaskWorktrees,
  prepareTaskWorktree,
  recoverTaskWorktrees,
  releaseTaskWorktree,
} from "./worktree-manager";
import {
  discoverWorkspaceSkillCatalog,
  discoverWorkspaceSkills,
} from "./skill-discovery";
import { resolveActiveSkills } from "../lib/skill-registry";

const PORT = Number(process.env.CONDUCTOR_COMPANION_PORT ?? 8765);
const HOST = process.env.CONDUCTOR_COMPANION_HOST ?? "127.0.0.1";
const ROOT = process.env.CONDUCTOR_WORKSPACE_ROOT ?? process.cwd();
let activeRoot = path.resolve(ROOT);
const MAX_BODY_BYTES = 4_500_000;
const ALLOWED_ORIGINS = new Set(
  (process.env.CONDUCTOR_ALLOWED_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
type JsonRecord = Record<string, unknown>;

async function selectWorkspaceRoot(requested: string) {
  const resolved = path.resolve(requested);
  const base = path.resolve(ROOT);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error("Repository path must stay inside the companion workspace.");
  }
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) throw new Error("Repository path is not a directory.");
  await stat(path.join(resolved, ".git"));
  activeRoot = resolved;
  await recoverTaskWorktrees(activeRoot);
  return activeRoot;
}

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

function flattenWorkspaceFiles(entries: unknown[], output: string[] = []): string[] {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (value.type === "file" && typeof value.path === "string") output.push(value.path);
    if (Array.isArray(value.children)) flattenWorkspaceFiles(value.children, output);
    if (output.length >= 200) break;
  }
  return output;
}

function approvalToken(request: IncomingMessage) {
  const value = request.headers["x-conductor-approval"];
  return Array.isArray(value) ? value[0] : value;
}

function mutationTaskId(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as JsonRecord;
  const mutation = body.contractMutation;
  if (!mutation || typeof mutation !== "object" || Array.isArray(mutation)) return undefined;
  const taskId = (mutation as JsonRecord).taskId;
  return typeof taskId === "string" && taskId.trim() ? taskId.trim() : undefined;
}

async function mutationRoot(value: unknown) {
  const taskId = mutationTaskId(value);
  if (!taskId) return activeRoot;
  return (await prepareTaskWorktree(activeRoot, taskId)).path;
}

async function approvedBody(request: IncomingMessage, action: string) {
  const body = await readBody(request);
  const event = normalizeAgentToolEvent({ name: action, status: "called", source: "companion" });
  if (!toolRequiresApproval(event)) throw new Error("Mutation route must be approval-gated.");
  const head = await runGit(activeRoot, ["rev-parse", "HEAD"]);
  validateContractBoundInput(body, action, head.stdout.trim());
  const root = await mutationRoot(body);
  consumeApproval(approvalToken(request), action, body);
  return { body, root };
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
      const [top, branch] = await Promise.all([runGit(activeRoot, ["rev-parse", "--show-toplevel"]), runGit(activeRoot, ["branch", "--show-current"])]);
      return send(response, 200, {
        ok: true,
        root: top.stdout.trim(),
        branch: branch.stdout.trim(),
        executionMode: process.env.CONDUCTOR_EXECUTION_MODE ?? "host-readonly",
        capabilities: [
          "filesystem",
          "terminal",
          "git-local",
          "git-remote-readonly",
        ],
        integrations: { github: false, githubPublication: "server-github-app-only" },
      });
    }

    if (request.method === "POST" && url.pathname === "/workspace/select") {
      const body = await readBody(request);
      if (typeof body.path !== "string" || !body.path.trim()) throw new Error("path is required.");
      const root = await selectWorkspaceRoot(body.path);
      const [branch, head] = await Promise.all([
        runGit(root, ["branch", "--show-current"]),
        runGit(root, ["rev-parse", "--short=12", "HEAD"]),
      ]);
      return send(response, 200, {
        ok: true,
        root,
        branch: branch.stdout.trim(),
        head: head.stdout.trim(),
      });
    }

    if (request.method === "GET" && url.pathname === "/worktrees") {
      return send(response, 200, { ok: true, root: activeRoot, worktrees: await listTaskWorktrees(activeRoot) });
    }
    if (request.method === "POST" && url.pathname === "/worktrees/prepare") {
      const approved = await approvedBody(request, "worktree.prepare");
      const body = approved.body;
      if (typeof body.taskId !== "string") throw new Error("taskId is required.");
      const record = await prepareTaskWorktree(activeRoot, body.taskId, typeof body.baseRef === "string" ? body.baseRef : "HEAD");
      return send(response, 200, { ok: true, worktree: record });
    }
    if (request.method === "POST" && url.pathname === "/worktrees/release") {
      const approved = await approvedBody(request, "worktree.release");
      const body = approved.body;
      if (typeof body.taskId !== "string") throw new Error("taskId is required.");
      const record = await releaseTaskWorktree(activeRoot, body.taskId, body.force === true);
      return send(response, 200, { ok: true, worktree: record });
    }

    if (request.method === "POST" && url.pathname === "/git/clone") {
      return send(response, 410, {
        ok: false,
        error: "Remote clone is retired in the companion. Select an installation repository through the authenticated server-side GitHub App route.",
      });
    }

    if (request.method === "POST" && url.pathname === "/approvals/request") {
      const body = await readBody(request);
      if (typeof body.action !== "string" || !body.input || typeof body.input !== "object") throw new Error("action and input are required.");
      const head = await runGit(activeRoot, ["rev-parse", "HEAD"]);
      validateContractBoundInput(body.input as JsonRecord, body.action, head.stdout.trim());
      await mutationRoot(body.input);
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
      return send(response, 200, { ok: true, root: activeRoot, entries: await listWorkspace(activeRoot, requested, depth) });
    }
    if (request.method === "POST" && url.pathname === "/fs/read") {
      const body = await readBody(request);
      if (typeof body.path !== "string") throw new Error("path is required.");
      return send(response, 200, { ok: true, ...(await readWorkspaceFile(activeRoot, body.path)) });
    }
    if (request.method === "GET" && url.pathname === "/skills/catalog") {
      const catalog = await discoverWorkspaceSkillCatalog(activeRoot);
      return send(response, 200, { ok: true, catalog });
    }
    if (request.method === "POST" && url.pathname === "/skills/resolve") {
      const body = await readBody(request);
      const message = typeof body.message === "string" ? body.message.trim().slice(0, 6_000) : "";
      const taskGoal = typeof body.taskGoal === "string" ? body.taskGoal.slice(0, 8_000) : null;
      const skillIds = Array.isArray(body.skillIds)
        ? body.skillIds.filter((value): value is string => typeof value === "string")
        : [];
      const catalog = await discoverWorkspaceSkills(activeRoot);
      try {
        const skills = resolveActiveSkills({
          catalog,
          message,
          explicitIds: skillIds,
          taskGoal,
        });
        return send(response, 200, {
          ok: true,
          catalog: catalog.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            path: skill.path,
            disableModelInvocation: skill.disableModelInvocation,
          })),
          skills,
        });
      } catch (error) {
        return send(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : "Skill resolution failed.",
          catalog: catalog.map((skill) => skill.id),
        });
      }
    }
    if (request.method === "POST" && url.pathname === "/context/search") {
      const body = await readBody(request);
      const query = typeof body.query === "string" ? body.query.trim().slice(0, 2_000) : "";
      const maxFiles = Math.min(Math.max(Number(body.maxFiles) || 8, 1), 32);
      const maxTokens = Math.min(Math.max(Number(body.maxTokens) || 12_000, 256), 64_000);
      const entries = await listWorkspace(activeRoot, ".", 6) as unknown[];
      const paths = flattenWorkspaceFiles(entries);
      const files = [] as Array<{ path: string; content: string }>;
      for (const filePath of paths) {
        if (files.length >= 200) break;
        try {
          const file = await readWorkspaceFile(activeRoot, filePath);
          if (file.content.trim()) files.push({ path: file.path, content: file.content.slice(0, 32_000) });
        } catch {
          // Binary, unreadable, and sensitive files are omitted from context.
        }
      }
      const snapshotId = `companion-${Date.now().toString(36)}`;
      const index = buildRepositoryIndex(files, snapshotId, { maxFiles: 500 });
      const context = retrieveRepositoryContext(index, query, { maxFiles, maxTokens });
      return send(response, 200, { ok: true, ...context, inventoryFiles: files.length });
    }
    if (request.method === "POST" && url.pathname === "/fs/write") {
      const approved = await approvedBody(request, "fs.write");
      return send(response, 200, { ok: true, written: await writeWorkspaceFiles(approved.root, approved.body.files) });
    }
    if (request.method === "POST" && url.pathname === "/fs/delete") {
      const approved = await approvedBody(request, "fs.delete");
      return send(response, 200, { ok: true, deleted: await deleteWorkspacePaths(approved.root, approved.body.paths) });
    }
    if (request.method === "POST" && url.pathname === "/terminal/execute") {
      const approved = await approvedBody(request, "terminal.execute");
      return send(response, 200, { ok: true, ...(await runShell(approved.root, approved.body)) });
    }
    if (request.method === "POST" && url.pathname === "/terminal/execute-batch") {
      const approved = await approvedBody(request, "terminal.execute-batch");
      return send(response, 200, { ok: true, ...(await runShellBatch(approved.root, approved.body)) });
    }

    if (request.method === "GET" && url.pathname === "/git/status") {
      const [top, branch, head, status, remotes] = await Promise.all([
        runGit(activeRoot, ["rev-parse", "--show-toplevel"]), runGit(activeRoot, ["branch", "--show-current"]),
        runGit(activeRoot, ["rev-parse", "--short=12", "HEAD"]), runGit(activeRoot, ["status", "--short"]), runGit(activeRoot, ["remote", "-v"]),
      ]);
      return send(response, 200, { ok: true, root: top.stdout.trim(), branch: branch.stdout.trim(), head: head.stdout.trim(), files: parseStatus(status.stdout), raw: status.stdout, remotes: remotes.stdout });
    }
    if (request.method === "POST" && url.pathname === "/git/diff") {
      const body = await readBody(request);
      const paths = Array.isArray(body.paths) && body.paths.length ? normalizePaths(body.paths) : [];
      const result = await runGit(activeRoot, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--", ...paths]);
      return send(response, 200, { ok: true, stdout: result.stdout, stderr: result.stderr });
    }
    if (request.method === "POST" && url.pathname === "/git/commit") {
      const approved = await approvedBody(request, "git.commit");
      const body = approved.body;
      const paths = normalizePaths(body.paths);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message || message.length > 200) throw new Error("message must be 1 to 200 characters.");
      await runGit(approved.root, ["add", "--", ...paths]);
      const result = await runGit(approved.root, ["commit", "-m", message]);
      const head = await runGit(approved.root, ["rev-parse", "--short=12", "HEAD"]);
      return send(response, 200, { ok: true, head: head.stdout.trim(), stdout: result.stdout, stderr: result.stderr });
    }
    if (request.method === "POST" && url.pathname === "/git/action") {
      return send(response, 410, {
        ok: false,
        error: "The legacy /git/action remote path is retired. Protected publication is available only through the server-side GitHub App merge route.",
      });
    }
    if (request.method === "POST" && url.pathname.startsWith("/provider/github/")) {
      return send(response, 410, {
        ok: false,
        error: "Legacy shared-token GitHub publication is retired. Use the server-side GitHub App publication permit flow.",
      });
    }

    if (request.method === "POST" && url.pathname === "/mcp/read") {
      const body = await readBody(request);
      if (typeof body.name !== "string" || !body.name.trim()) throw new Error("name is required.");
      const gatewayUrl = process.env.MCP_GATEWAY_URL?.trim();
      if (!gatewayUrl) throw new Error("MCP_GATEWAY_URL is not configured in the companion environment.");
      const result = await invokeReadOnlyMcpTool({
        gatewayUrl,
        name: body.name,
        arguments: body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments) ? body.arguments as Record<string, unknown> : {},
        transport: async (target, envelope) => {
          const gatewayResponse = await fetch(target, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(process.env.MCP_GATEWAY_TOKEN?.trim() ? { Authorization: `Bearer ${process.env.MCP_GATEWAY_TOKEN.trim()}` } : {}),
            },
            body: JSON.stringify(envelope),
          });
          const payload = await gatewayResponse.json() as unknown;
          if (!gatewayResponse.ok) throw new Error(`MCP gateway failed (${gatewayResponse.status}).`);
          return payload;
        },
      });
      return send(response, 200, { ok: true, result });
    }

    return send(response, 404, { ok: false, error: "Not found." });
  } catch (error) {
    const pathname = request.url?.split("?")[0] ?? "companion.request";
    const failure = normalizeToolFailure(error, pathname);
    return send(response, 400, { ok: false, error: failure });
  }
}

export function startCompanionServer() {
  return createServer((request, response) => void handle(request, response)).listen(PORT, HOST, () => {
    process.stdout.write(`Conductor execution companion listening on http://${HOST}:${PORT}\nWorkspace: ${ROOT}\n`);
  });
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) startCompanionServer();
