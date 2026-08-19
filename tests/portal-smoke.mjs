import { mkdir, writeFile } from "node:fs/promises";

const baseUrl = (process.env.BENCHMARK_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const companionUrl = (process.env.BENCHMARK_COMPANION_URL || `${baseUrl}/api/companion`).replace(/\/$/, "");
const model = process.env.BENCHMARK_MODEL || "gpt-5.1-codex-mini";

const askEngines = ["openai-agents", "langgraph", "crewai"];
const agentEngines = ["openai-agents", "langgraph"];

async function fetchContext(message) {
  try {
    const response = await fetch(`${companionUrl}/context/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: message, maxFiles: 8, maxTokens: 12_000 }),
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload.files) ? payload.files : [];
  } catch {
    return [];
  }
}

async function ensureSmokeTask() {
  const stateResponse = await fetch(`${baseUrl}/api/workspace?workspaceId=workspace_local`);
  if (stateResponse.ok) {
    const state = await stateResponse.json();
    const taskId = state.activeTask?.id ?? state.tasks?.[0]?.id;
    if (taskId) return taskId;
  }
  const key = `portal-smoke-task-${Date.now()}`;
  const createResponse = await fetch(`${baseUrl}/api/workspace`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({
      action: "create_task",
      workspaceId: "workspace_local",
      idempotencyKey: key,
      title: "Portal smoke task",
      goal: "Bounded portal agent smoke for proposal flow.",
      riskLevel: "R1",
      branch: "portal-smoke",
    }),
  });
  const created = await createResponse.json();
  if (!createResponse.ok) {
    throw new Error(created.error?.code ?? `create_task failed (${createResponse.status})`);
  }
  return created.task?.id ?? created.activeTask?.id;
}

async function callAgent(args) {
  const key = `portal-smoke-${args.engine}-${args.mode}-${Date.now()}`;
  const started = Date.now();
  const response = await fetch(`${baseUrl}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({
      message: args.message,
      mode: args.mode,
      engine: args.engine,
      model,
      skills: args.skills,
      taskId: args.taskId,
      workspaceId: "workspace_local",
      idempotencyKey: key,
      workspace: { repository: "workspace", branch: "main" },
    }),
  });
  const payload = await response.json();
  if (!response.ok && args.retry502 && response.status === 502) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return callAgent({ ...args, retry502: false });
  }
  return {
    engine: args.engine,
    mode: args.mode,
    ok: response.ok,
    status: response.status,
    durationMs: Date.now() - started,
    answer: payload.output?.summary ?? null,
    error: payload.error?.code ?? null,
    riskLevel: payload.output?.riskLevel ?? null,
    needsApproval: payload.output?.needsApproval ?? null,
  };
}

const askMessage = "According to the conductor-workspace skill, what language should user-visible answers use? Reply in one short Thai sentence.";
const agentMessage = "Propose creating hello-smoke.txt with content 'portal smoke ok'. Do not claim it was written.";
const workspaceFiles = await fetchContext(askMessage);
const smokeTaskId = await ensureSmokeTask();

const results = [];
for (const engine of askEngines) {
  results.push(await callAgent({
    engine,
    mode: "ask",
    message: askMessage,
    skills: ["conductor-workspace"],
    retry502: true,
  }));
}
for (const engine of agentEngines) {
  results.push(await callAgent({
    engine,
    mode: "agent",
    message: agentMessage,
    taskId: smokeTaskId,
  }));
}

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  model,
  contextFiles: workspaceFiles.map((file) => file.path),
  summary: {
    runs: results.length,
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
  },
  results,
};

await mkdir("outputs", { recursive: true });
await writeFile("outputs/portal-smoke.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.summary.failed > 0) process.exit(1);
