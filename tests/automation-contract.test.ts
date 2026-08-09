import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  automationWebhookSignaturePayload,
  nextScheduledRun,
  parseAutomationProfileDefinition,
  parseAutomationTrigger,
} from "../lib/automation-contract.ts";

test("automation triggers fail closed and schedules remain bounded", () => {
  assert.deepEqual(parseAutomationTrigger({ type: "command", command: "daily-review" }), { type: "command", command: "daily-review" });
  assert.throws(() => parseAutomationTrigger({ type: "command", command: "git push origin main" }), /limited/i);
  assert.throws(() => parseAutomationTrigger({ type: "schedule", every: "0 * * * *" }), /limited/i);
  assert.equal(nextScheduledRun(parseAutomationTrigger({ type: "schedule", every: "*/15 * * * *" }), new Date("2026-08-09T12:01:00Z")), "2026-08-09T12:15:00.000Z");
});

test("agent and skill profiles are bounded, typed, and immutable-version friendly", () => {
  assert.deepEqual(parseAutomationProfileDefinition("agent", {
    systemPrompt: "ตอบเป็นภาษาไทยและรอการอนุมัติ",
    model: "gpt-5.1-codex-mini",
    maxSteps: 8,
  }), {
    systemPrompt: "ตอบเป็นภาษาไทยและรอการอนุมัติ",
    model: "gpt-5.1-codex-mini",
    maxSteps: 8,
  });
  assert.deepEqual(parseAutomationProfileDefinition("skill", { skills: ["repository-search", "test-runner"] }), { skills: ["repository-search", "test-runner"] });
  assert.throws(() => parseAutomationProfileDefinition("agent", { systemPrompt: "" }), /invalid/i);
  assert.throws(() => parseAutomationProfileDefinition("skill", { skills: ["git push origin main"] }), /invalid/i);
});

test("webhook signatures bind the exact workspace, hook, and body bytes", () => {
  const body = new TextEncoder().encode('{"event":"test"}');
  const expected = automationWebhookSignaturePayload("workspace-a", "hook-a", body);
  assert.notDeepEqual(expected, automationWebhookSignaturePayload("workspace-b", "hook-a", body));
  assert.notDeepEqual(expected, automationWebhookSignaturePayload("workspace-a", "hook-b", body));
  assert.notDeepEqual(expected, automationWebhookSignaturePayload("workspace-a", "hook-a", new TextEncoder().encode('{"event": "test"}')));
});

test("automation API is owner-authenticated, scheduler-authenticated, leased, and approval-gated", async () => {
  const [route, tick, webhook, store, migration, panel] = await Promise.all([
    readFile(new URL("../app/api/automations/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/automations/tick/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/automations/webhook/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/environment-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0007_steady_tomorrow_man.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/portal/automations-panel.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(route, /authenticateServerPrincipal/);
  assert.doesNotMatch(route, /input\.actor|body\.actor/);
  assert.match(route, /INSERT OR IGNORE INTO automation_runs/);
  assert.match(route, /status = 'materializing'/);
  assert.match(route, /automation_run_lease_lost/);
  assert.match(route, /Human approval is required/);
  assert.match(route, /UPDATE approvals SET status = 'withdrawn'/);
  assert.match(route, /AND status NOT IN \('completed', 'cancelled'\)/);
  assert.match(route, /automation_run_cancel_conflict/);
  assert.match(route, /A paused automation cannot be replayed/);
  assert.match(route, /snapshotId = crypto\.randomUUID\(\)/);
  assert.match(route, /replay:\$\{input\.runId\}/);
  assert.match(tick, /CONDUCTOR_AUTOMATION_SCHEDULER_SECRET/);
  assert.match(tick, /x-conductor-scheduler-signature/);
  assert.match(tick, /recovery_key/);
  assert.match(tick, /expectedScheduleSlot/);
  assert.match(tick, /AND next_run_at = \?/);
  assert.match(webhook, /CONDUCTOR_AUTOMATION_WEBHOOK_SECRET/);
  assert.match(webhook, /request\.arrayBuffer/);
  assert.match(webhook, /automationWebhookSignaturePayload\(workspaceId, hookId, raw\)/);
  assert.match(store, /automation_events_no_update/);
  assert.match(store, /automation_events_no_delete/);
  assert.match(store, /automation_profiles_no_update/);
  assert.match(store, /automation_profiles_no_delete/);
  assert.match(store, /automation_snapshots_no_update/);
  assert.match(store, /automation_snapshots_no_delete/);
  assert.match(migration, /automation_snapshots/);
  assert.match(migration, /automation_events_no_update/);
  assert.match(migration, /automation_profiles_no_update/);
  assert.match(migration, /automation_snapshots_no_update/);
  assert.match(panel, /System prompt/);
  assert.match(panel, /Allowlisted skills/);
  assert.match(panel, /Signed webhook/);
  assert.match(panel, /Allowlisted command/);
  assert.doesNotMatch(panel, /Tick due schedules/);
});
