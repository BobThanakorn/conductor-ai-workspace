import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const baseUrl = (process.env.BENCHMARK_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const iterations = Math.max(1, Math.min(10, Number(process.env.BENCHMARK_ITERATIONS || 3)));
const prompt = process.env.BENCHMARK_PROMPT ||
  "In Ask mode, explain in one sentence what this repository does. Do not modify files or run commands.";

const modelsResponse = await fetch(`${baseUrl}/api/models`);
if (!modelsResponse.ok) throw new Error(`Model discovery failed (${modelsResponse.status}).`);
const modelsPayload = await modelsResponse.json();
const model = process.env.BENCHMARK_MODEL || modelsPayload.model;
if (!model) throw new Error("No benchmark model is configured.");

const readyEngines = (modelsPayload.engines || [])
  .filter((engine) => engine.status === "ready")
  .map((engine) => engine.id);
if (!readyEngines.length) throw new Error("No ready Agent engine is available.");

const results = [];
for (const engine of readyEngines) {
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    const key = `benchmark-${engine}-${Date.now()}-${iteration}`;
    const started = performance.now();
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
        workspaceId: "workspace_local",
        idempotencyKey: key,
        workspaceFiles: [],
        workspace: {
          repository: "workspace",
          branch: "main",
        },
      }),
    });
    const payload = await response.json();
    results.push({
      engine,
      model,
      iteration,
      ok: response.ok,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
      providerDurationMs: payload.telemetry?.providerDurationMs ??
        payload.orchestration?.metrics?.durationMs ??
        null,
      question: prompt,
      answer: payload.output?.summary ?? null,
      tokenUsage: payload.telemetry?.tokenUsage ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      tools: payload.telemetry?.tools ?? [],
      auditLog: payload.telemetry?.auditLog ?? [],
      proposalPolicyNormalized: payload.proposalPolicy?.normalized ?? null,
      error: payload.error?.code ?? null,
    });
  }
}

const summary = Object.fromEntries(readyEngines.map((engine) => {
  const samples = results.filter((result) => result.engine === engine);
  const passed = samples.filter((sample) => sample.ok);
  const durations = passed.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const totalTokens = passed.reduce((sum, sample) => sum + (sample.tokenUsage?.totalTokens ?? 0), 0);
  const toolEvents = passed.reduce((sum, sample) => sum + (sample.tools?.length ?? 0), 0);
  return [engine, {
    runs: samples.length,
    successRate: samples.length ? passed.length / samples.length : 0,
    medianDurationMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
    minDurationMs: durations[0] ?? null,
    maxDurationMs: durations.at(-1) ?? null,
    averageTotalTokens: passed.length ? Math.round(totalTokens / passed.length) : null,
    toolEvents,
  }];
}));

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  model,
  prompt,
  iterations,
  summary,
  results,
};
await writeFile("outputs/agent-sdk-benchmark.json", `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
