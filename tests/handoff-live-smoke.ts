import { readFile } from "node:fs/promises";

import { createHandoffIdentityToken, type HandoffPrincipal } from "../lib/handoff-identity.ts";

const baseUrl = (process.env.CONDUCTOR_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const workspaceId = process.env.CONDUCTOR_SMOKE_WORKSPACE_ID ?? "workspace_local";

type ApiBody = {
  workspace?: { repository?: { headSha?: string; baseSha?: string } };
  task?: { id?: string };
  handoff?: { id?: string; evidenceDigest?: string; publishedBy?: string };
  handoffs?: unknown[];
  detailLevel?: string;
  error?: unknown;
};

async function signingSecret(): Promise<string> {
  if (process.env.CONDUCTOR_HANDOFF_SIGNING_SECRET?.trim()) return process.env.CONDUCTOR_HANDOFF_SIGNING_SECRET.trim();
  const contents = await readFile(new URL("../.env", import.meta.url), "utf8");
  const line = contents.split(/\r?\n/).find((entry) => entry.trim().startsWith("CONDUCTOR_HANDOFF_SIGNING_SECRET="));
  const value = line?.slice(line.indexOf("=") + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!value) throw new Error("CONDUCTOR_HANDOFF_SIGNING_SECRET is required for the live smoke test.");
  return value;
}

async function request(path: string, options: RequestInit = {}, expected: number | number[] = 200) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json().catch(() => ({})) as ApiBody;
  const expectedStatuses = Array.isArray(expected) ? expected : [expected];
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return { status: response.status, body };
}

function idempotency(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

function requireHandoff(body: ApiBody): { id: string; evidenceDigest: string; publishedBy?: string } {
  if (!body.handoff?.id || !body.handoff.evidenceDigest) throw new Error("The handoff response is incomplete.");
  return { id: body.handoff.id, evidenceDigest: body.handoff.evidenceDigest, ...(body.handoff.publishedBy ? { publishedBy: body.handoff.publishedBy } : {}) };
}

async function post(path: string, body: Record<string, unknown>, token?: string, expected: number | number[] = 200) {
  const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : idempotency("handoff-smoke");
  return request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      ...(token ? { "X-Conductor-Identity": token } : {}),
    },
    body: JSON.stringify({ ...body, idempotencyKey: key }),
  }, expected);
}

async function token(input: {
  actorId: string;
  role: HandoffPrincipal["role"];
  kind?: HandoffPrincipal["kind"];
  taskId: string;
  workspace?: string;
}) {
  return createHandoffIdentityToken({
    actorId: input.actorId,
    role: input.role,
    kind: input.kind ?? "worker",
    workspaceId: input.workspace ?? workspaceId,
    taskId: input.taskId,
    secret: await signingSecret(),
  });
}

async function main() {
  const state = await request(`/api/workspace?workspaceId=${encodeURIComponent(workspaceId)}`);
  const snapshotId = state.body.workspace?.repository?.headSha || state.body.workspace?.repository?.baseSha;
  if (!snapshotId) throw new Error("The workspace does not expose a repository snapshot SHA.");
  const created = await post("/api/workspace", {
    action: "create_task",
    workspaceId,
    title: `Handoff live smoke ${Date.now()}`,
    goal: "Verify signed and durable role handoff gates.",
    riskLevel: "R1",
    dependsOn: [],
    maxAttempts: 1,
  }, undefined, 201);
  const taskId = created.body.task?.id as string;
  if (!taskId) throw new Error("The smoke task was not created.");
  const report: Record<string, unknown> = { taskId, snapshotId, checks: [] as string[] };
  const checks = report.checks as string[];
  try {
    const [planner, implementer, tester, reviewer, selfReviewer, human, wrongWorkspace] = await Promise.all([
      token({ actorId: "worker:planner-smoke", role: "planner", taskId }),
      token({ actorId: "worker:implementer-smoke", role: "implementer", taskId }),
      token({ actorId: "worker:tester-smoke", role: "tester", taskId }),
      token({ actorId: "worker:reviewer-smoke", role: "reviewer", taskId }),
      token({ actorId: "worker:tester-smoke", role: "reviewer", taskId }),
      token({ actorId: "human:operator-smoke", role: "reviewer", kind: "human", taskId }),
      token({ actorId: "worker:planner-smoke", role: "planner", taskId, workspace: "workspace_forbidden" }),
    ]);
    const content = "export const handoffSmoke = true;";
    const context = { snapshotId, files: [{ path: "tests/handoff-smoke.ts", content, snapshotId }], totalTokens: Math.ceil(content.length / 4) };
    const evidence = { summary: "Live handoff smoke evidence", files: [{ path: "tests/handoff-smoke.ts", change: "validated only" }], checks: [{ command: "npm test", exitCode: 0, stdout: "verified" }] };

    const summaryBefore = await request(`/api/handoffs?workspaceId=${encodeURIComponent(workspaceId)}&taskId=${encodeURIComponent(taskId)}`);
    if (summaryBefore.body.detailLevel !== "summary") throw new Error("Unauthenticated handoff listing did not stay summary-only.");
    checks.push("unauthenticated listing is summary-only");
    await request(`/api/handoffs?workspaceId=${encodeURIComponent(workspaceId)}&taskId=${encodeURIComponent(taskId)}&details=full`, {}, 401);
    checks.push("full evidence requires signed identity");

    await post("/api/handoffs", { action: "create", workspaceId, taskId, fromRole: "planner", toRole: "implementer", context, evidence }, wrongWorkspace, 403);
    checks.push("cross-workspace token denied");

    const first = await post("/api/handoffs", { action: "create", workspaceId, taskId, fromRole: "planner", toRole: "implementer", context, evidence }, planner, 201);
    await post("/api/handoffs", { action: "accept", workspaceId, handoffId: requireHandoff(first.body).id }, implementer);
    const second = await post("/api/handoffs", { action: "create", workspaceId, taskId, fromRole: "implementer", toRole: "tester", context, evidence }, implementer, 201);
    await post("/api/handoffs", { action: "accept", workspaceId, handoffId: requireHandoff(second.body).id }, tester);
    const third = await post("/api/handoffs", { action: "create", workspaceId, taskId, fromRole: "tester", toRole: "reviewer", context, evidence }, tester, 201);
    const thirdHandoff = requireHandoff(third.body);
    const handoffId = thirdHandoff.id;
    const digest = thirdHandoff.evidenceDigest;
    await post("/api/handoffs", { action: "accept", workspaceId, handoffId }, reviewer);
    checks.push("planner to reviewer chain accepted sequentially");

    await post("/api/handoffs", { action: "review", workspaceId, handoffId, decision: "approve", evidenceDigest: digest }, selfReviewer, 403);
    checks.push("canonical actor self-review denied");
    await post("/api/handoffs", { action: "review", workspaceId, handoffId, decision: "approve", evidenceDigest: "0".repeat(64) }, reviewer, 409);
    checks.push("digest mismatch created conflict");
    await post("/api/handoffs", { action: "resolve", workspaceId, handoffId, resolution: "retry" }, human);
    await post("/api/handoffs", { action: "accept", workspaceId, handoffId }, reviewer);
    await post("/api/handoffs", { action: "review", workspaceId, handoffId, decision: "approve", evidenceDigest: digest }, reviewer);
    checks.push("independent reviewer approved immutable evidence");
    await post("/api/handoffs", { action: "publish", workspaceId, handoffId }, reviewer, 403);
    const publication = await post("/api/handoffs", { action: "publish", workspaceId, handoffId }, human);
    if (publication.body.handoff?.publishedBy !== "human:operator-smoke") throw new Error("The durable publication actor was not returned.");
    checks.push("only signed human recorded publication authorization");

    const full = await request(`/api/handoffs?workspaceId=${encodeURIComponent(workspaceId)}&taskId=${encodeURIComponent(taskId)}&details=full`, { headers: { "X-Conductor-Identity": reviewer } });
    if (!Array.isArray(full.body.handoffs) || full.body.handoffs.length !== 3 || full.body.detailLevel !== "full") throw new Error("Protected full handoff evidence was not returned correctly.");
    checks.push("task-scoped reviewer can inspect protected evidence");
    report.ok = true;
  } finally {
    await post("/api/workspace", { action: "cancel", workspaceId, taskId, reason: "P2-T3 live smoke cleanup", actor: "Codex smoke" }).catch(() => undefined);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Handoff live smoke failed."}\n`);
  process.exitCode = 1;
});
