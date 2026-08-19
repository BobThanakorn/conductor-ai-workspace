import { writeFile, mkdir } from "node:fs/promises";

const baseUrl = (process.env.BENCHMARK_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const prompt =
  process.env.SKILLS_SMOKE_PROMPT ||
  "According to the conductor-workspace skill, what language should user-visible answers use? Reply in one short Thai sentence.";
const engines = (process.env.SKILLS_SMOKE_ENGINES || "openai-agents,langgraph,crewai")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const modelsResponse = await fetch(`${baseUrl}/api/models`);
if (!modelsResponse.ok) throw new Error(`Model discovery failed (${modelsResponse.status}).`);
const modelsPayload = await modelsResponse.json();
const readyModels = Object.entries(modelsPayload.modelStatus ?? {})
  .filter(([, status]) => status === "ready")
  .map(([id]) => id);
const model = process.env.BENCHMARK_MODEL || readyModels[0] || modelsPayload.model;
if (!model) throw new Error("No benchmark model is configured.");

const results = [];
for (const engine of engines) {
  const key = `skills-smoke-${engine}-${Date.now()}`;
  const started = Date.now();
  const response = await fetch(`${baseUrl}/api/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({
      message: prompt,
      mode: "ask",
      engine,
      model,
      skills: ["conductor-workspace"],
      workspaceId: "workspace_local",
      idempotencyKey: key,
      workspace: { repository: "workspace", branch: "main" },
    }),
  });
  const payload = await response.json();
  const answer = payload.output?.summary ?? payload.answer ?? null;
  const mentionsThai = /ไทย|thai/i.test(String(answer ?? ""));
  results.push({
    engine,
    ok: response.ok,
    status: response.status,
    durationMs: Date.now() - started,
    answer,
    skillEvidence: mentionsThai,
    error: payload.error?.code ?? null,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  model,
  prompt,
  skills: ["conductor-workspace"],
  summary: {
    runs: results.length,
    passed: results.filter((result) => result.ok && result.skillEvidence).length,
    failed: results.filter((result) => !result.ok || !result.skillEvidence).length,
  },
  results,
};

await mkdir("outputs", { recursive: true });
await writeFile("outputs/skills-smoke.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.summary.failed > 0) process.exit(1);
