import process from "node:process";
import { ApiError, errorResponse, jsonResponse } from "@/lib/api-contract";
import {
  automationWebhookSignaturePayload,
  parseAutomationTrigger,
} from "@/lib/automation-contract";
import { ensureEnvironmentDatabase, getDatabase } from "@/lib/environment-store";
import { materializeAutomationRun } from "../route";

export const dynamic = "force-dynamic";

function equal(a: string, b: string) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

export async function POST(request: Request) {
  try {
    const workspaceId = request.headers.get("x-conductor-workspace")?.trim() ?? "";
    const hookId = request.headers.get("x-conductor-hook-id")?.trim() ?? "";
    const signature = request.headers.get("x-conductor-hook-signature")?.trim() ?? "";
    if (!workspaceId || !hookId || !signature || !process.env.CONDUCTOR_AUTOMATION_WEBHOOK_SECRET?.trim()) throw new ApiError(401, "automation_webhook_unauthorized", "Automation webhook authentication is required.");
    const raw = new Uint8Array(await request.arrayBuffer());
    const signedPayload = automationWebhookSignaturePayload(workspaceId, hookId, raw);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(process.env.CONDUCTOR_AUTOMATION_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(signedPayload).buffer))].map((v) => v.toString(16).padStart(2, "0")).join("");
    if (!equal(expected, signature.replace(/^sha256=/, "").toLowerCase())) throw new ApiError(401, "automation_webhook_unauthorized", "Automation webhook authentication failed.");
    const database = getDatabase(); await ensureEnvironmentDatabase(database);
    const rows = await database.prepare("SELECT * FROM automations WHERE workspace_id = ? AND enabled = 1 LIMIT 100").bind(workspaceId).all<Record<string, unknown>>();
    const runs = []; for (const item of rows.results) { const trigger = parseAutomationTrigger(JSON.parse(String(item.trigger_json))); if (trigger.type === "webhook" && trigger.hookId === hookId) runs.push(await materializeAutomationRun(database, item, String(item.owner_id), `webhook:${hookId}:${expected}`)); }
    return jsonResponse({ ok: true, runs }, 202);
  } catch (error) { return errorResponse(error); }
}
