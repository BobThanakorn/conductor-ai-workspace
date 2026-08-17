import { readFileSync } from "node:fs";

const baseUrl = (process.env.OPENHANDS_BASE_URL ?? "http://127.0.0.1:3002").replace(/\/$/, "");
const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
const env = Object.fromEntries(
  envText.split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

const llmApiKey = process.env.LLM_API_KEY ?? env.AZURE_AI_FOUNDRY_API_KEY ?? env.OPENAI_API_KEY ?? env.VLLM_API_KEY ?? "";
const llmModel = process.env.LLM_MODEL ?? (env.AZURE_AI_FOUNDRY_MODEL ? `azure/${env.AZURE_AI_FOUNDRY_MODEL}` : "openai/qwen3.6");
const llmBaseUrl = process.env.LLM_BASE_URL
  ?? (env.AZURE_AI_FOUNDRY_ENDPOINT ? `${env.AZURE_AI_FOUNDRY_ENDPOINT.replace(/\/$/, "")}/openai/v1` : "")
  ?? env.OPENAI_BASE_URL
  ?? env.VLLM_BASE_URL
  ?? "";

async function configureSettings() {
  const payload = {
    agent_settings_diff: {
      llm: {
        model: llmModel,
        ...(llmBaseUrl ? { base_url: llmBaseUrl } : {}),
        ...(llmApiKey ? { api_key: llmApiKey } : {}),
      },
    },
  };
  const response = await request("/api/v1/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.status >= 400) {
    throw new Error(`Settings store failed (${response.status}): ${JSON.stringify(response.body).slice(0, 500)}`);
  }
  return response.body;
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const health = await request("/health");
  if (health.status !== 200) throw new Error(`OpenHands health failed: ${health.status}`);
  const settings = await configureSettings();

  const prompt = [
    "Smoke test only.",
    "Create file work/openhands-smoke.txt with content: openhands probe",
    "Then run: python3 -c \"print(1)\"",
    "Stop after those two steps.",
  ].join("\n");

  const start = await request("/api/v1/app-conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `OpenHands smoke ${Date.now()}`,
      llm_model: llmModel,
      initial_message: {
        role: "user",
        run: true,
        content: [{ type: "text", text: prompt }],
      },
    }),
  });

  if (start.status >= 400) {
    throw new Error(`Start conversation failed (${start.status}): ${JSON.stringify(start.body).slice(0, 500)}`);
  }

  const taskId = start.body?.id ?? start.body?.start_task_id ?? start.body?.task_id;
  const conversationId = start.body?.app_conversation_id ?? start.body?.conversation_id;

  let resolvedConversationId = conversationId;
  if (taskId && !resolvedConversationId) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const task = await request(`/api/v1/app-conversations/start-tasks/${taskId}`);
      const status = String(task.body?.status ?? task.body?.state ?? "").toUpperCase();
      const detail = task.body?.detail ?? "";
      resolvedConversationId = task.body?.app_conversation_id ?? task.body?.conversation_id ?? resolvedConversationId;
      if (status === "COMPLETED" || status === "READY" || resolvedConversationId) break;
      if (status === "FAILED" || status === "ERROR") {
        throw new Error(`Start task failed (${status}): ${detail || JSON.stringify(task.body).slice(0, 500)}`);
      }
      await sleep(5000);
    }
  }

  if (!resolvedConversationId) {
    throw new Error(`Conversation did not start: ${JSON.stringify(start.body).slice(0, 500)}`);
  }

  let lastEventSummary = "";
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const events = await request(`/api/v1/conversation/${resolvedConversationId}/events/search?limit=20`);
    const items = events.body?.items ?? events.body?.events ?? [];
    const textParts = items.flatMap((item) => {
      const content = item?.content ?? item?.message?.content ?? [];
      return Array.isArray(content)
        ? content.map((part) => part?.text ?? part?.content ?? "").filter(Boolean)
        : [String(item?.message ?? item?.summary ?? "")];
    }).filter(Boolean);
    lastEventSummary = textParts.at(-1) ?? lastEventSummary;
    const joined = textParts.join("\n").toLowerCase();
    if (joined.includes("openhands-smoke.txt") || joined.includes("finish") || joined.includes("completed")) {
      console.log(JSON.stringify({
        ok: true,
        health: health.body,
        settingsConfigured: Boolean(settings),
        llmModel,
        llmBaseUrl: llmBaseUrl ? "[configured]" : "[default]",
        conversationId: resolvedConversationId,
        eventCount: items.length,
        lastEvent: lastEventSummary.slice(0, 240),
      }));
      return;
    }
    await sleep(5000);
  }

  console.log(JSON.stringify({
    ok: false,
    conversationId: resolvedConversationId,
    reason: "timed_out_waiting_for_agent_events",
    lastEvent: lastEventSummary.slice(0, 240),
  }));
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});
