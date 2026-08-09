import { readFile } from "node:fs/promises";

import { createHandoffIdentityToken } from "../lib/handoff-identity.ts";
import { automationWebhookSignaturePayload } from "../lib/automation-contract.ts";

const baseUrl = (process.env.CONDUCTOR_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

async function envValue(name: string) {
  const configured = process.env[name]?.trim();
  if (configured) return configured;
  const contents = await readFile(new URL("../.env", import.meta.url), "utf8");
  const line = contents.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${name}=`));
  return line?.slice(line.indexOf("=") + 1).trim().replace(/^(?:"(.*)"|'(.*)')$/, "$1$2") ?? "";
}

async function responseJson(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function hmac(secret: string, raw: string | Uint8Array) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const payload = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(payload).buffer))].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function main() {
  const signingSecret = await envValue("CONDUCTOR_HANDOFF_SIGNING_SECRET");
  if (!signingSecret) throw new Error("CONDUCTOR_HANDOFF_SIGNING_SECRET is required for the automation live smoke.");
  const schedulerSecret = await envValue("CONDUCTOR_AUTOMATION_SCHEDULER_SECRET");
  if (!schedulerSecret) throw new Error("CONDUCTOR_AUTOMATION_SCHEDULER_SECRET is required for the automation live smoke.");
  const webhookSecret = await envValue("CONDUCTOR_AUTOMATION_WEBHOOK_SECRET");
  if (!webhookSecret) throw new Error("CONDUCTOR_AUTOMATION_WEBHOOK_SECRET is required for the automation live smoke.");
  const identity = await createHandoffIdentityToken({ actorId: "human:automation-smoke", role: "reviewer", kind: "human", workspaceId: "workspace_local", secret: signingSecret, ttlSeconds: 300 });
  const suffix = Date.now().toString(36);
  const headers = { "content-type": "application/json", "x-conductor-identity": identity };
  const post = (body: Record<string, unknown>) => responseJson("/api/automations", { method: "POST", headers, body: JSON.stringify({ workspaceId: "workspace_local", ...body }) });

  await post({ action: "profile", profileId: `smoke-agent-${suffix}`, kind: "agent", name: "Automation smoke agent", definition: { systemPrompt: "ตอบเป็นภาษาไทยและสร้างข้อเสนอเท่านั้น", maxSteps: 4 } });
  await post({ action: "profile", profileId: `smoke-skills-${suffix}`, kind: "skill", name: "Automation smoke skills", definition: { skills: ["repository-search", "test-runner"] } });
  const automationId = `automation-smoke-${suffix}`;
  await post({ action: "automation", automationId, name: "Automation live smoke", trigger: { type: "manual" }, agentProfileId: `smoke-agent-${suffix}`, agentProfileVersion: 1, skillProfileId: `smoke-skills-${suffix}`, skillProfileVersion: 1 });
  const idempotencyKey = `smoke-${suffix}`;
  const first = await post({ action: "run", automationId, idempotencyKey });
  const duplicate = await post({ action: "run", automationId, idempotencyKey });
  if (first.runId !== duplicate.runId || first.taskId !== duplicate.taskId || duplicate.replayed !== true) throw new Error("Run idempotency failed.");
  await post({ action: "cancel", runId: first.runId });
  const replay = await post({ action: "replay", runId: first.runId });
  if (!replay.runId || replay.runId === first.runId || replay.taskId === first.taskId) throw new Error("Replay did not create a new run and task.");
  await post({ action: "pause", automationId });
  const pausedRun = await fetch(`${baseUrl}/api/automations`, { method: "POST", headers, body: JSON.stringify({ workspaceId: "workspace_local", action: "run", automationId }) });
  const pausedReplay = await fetch(`${baseUrl}/api/automations`, { method: "POST", headers, body: JSON.stringify({ workspaceId: "workspace_local", action: "replay", runId: first.runId }) });
  if (pausedRun.status !== 409 || pausedReplay.status !== 409) throw new Error("Paused automation accepted a new or replayed run.");
  await post({ action: "resume", automationId });
  const state = await responseJson("/api/automations?workspaceId=workspace_local", { headers });
  const runs = state.runs as Array<Record<string, unknown>>;
  if (!runs.some((run) => run.id === first.runId && run.status === "cancelled")) throw new Error("Cancelled run was not persisted.");
  if (!runs.some((run) => run.id === replay.runId && run.status === "queued")) throw new Error("Replayed run was not queued.");

  const schedulerBody = JSON.stringify({ requestedAt: new Date().toISOString(), nonce: suffix });
  const unauthorized = await fetch(`${baseUrl}/api/automations/tick`, { method: "POST", headers: { "content-type": "application/json" }, body: schedulerBody });
  if (unauthorized.status !== 401) throw new Error(`Unsigned scheduler request returned ${unauthorized.status}.`);
  const scheduler = await responseJson("/api/automations/tick", { method: "POST", headers: { "content-type": "application/json", "x-conductor-scheduler-signature": `sha256=${await hmac(schedulerSecret, schedulerBody)}` }, body: schedulerBody });

  const hookId = `smoke-hook-${suffix}`;
  const webhookAutomationId = `automation-webhook-${suffix}`;
  await post({ action: "automation", automationId: webhookAutomationId, name: "Automation webhook smoke", trigger: { type: "webhook", hookId }, agentProfileId: `smoke-agent-${suffix}`, agentProfileVersion: 1, skillProfileId: `smoke-skills-${suffix}`, skillProfileVersion: 1 });
  const webhookBody = JSON.stringify({ event: "smoke", nonce: suffix });
  const rawWebhookBody = new TextEncoder().encode(webhookBody);
  const webhookSignature = await hmac(webhookSecret, automationWebhookSignaturePayload("workspace_local", hookId, rawWebhookBody));
  const webhook = await responseJson("/api/automations/webhook", { method: "POST", headers: { "content-type": "application/json", "x-conductor-workspace": "workspace_local", "x-conductor-hook-id": hookId, "x-conductor-hook-signature": `sha256=${webhookSignature}` }, body: webhookBody });
  if (!Array.isArray(webhook.runs) || webhook.runs.length !== 1) throw new Error("Signed webhook did not create exactly one scoped run.");
  const crossHookReplay = await fetch(`${baseUrl}/api/automations/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-conductor-workspace": "workspace_local", "x-conductor-hook-id": `${hookId}-other`, "x-conductor-hook-signature": `sha256=${webhookSignature}` }, body: webhookBody });
  if (crossHookReplay.status !== 401) throw new Error(`Cross-hook signature replay returned ${crossHookReplay.status}.`);

  process.stdout.write(`${JSON.stringify({ ok: true, automationId, idempotentRunId: first.runId, replayRunId: replay.runId, pausedRunBlocked: true, pausedReplayBlocked: true, cancelled: true, schedulerPrincipal: scheduler.principal, webhookScoped: true, crossHookReplayBlocked: true, secretsExposed: false }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Automation live smoke failed."}\n`);
  process.exitCode = 1;
});
