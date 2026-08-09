import process from "node:process";

import { ApiError, errorResponse, jsonResponse } from "@/lib/api-contract";
import { nextScheduledRun, parseAutomationTrigger } from "@/lib/automation-contract";
import { ensureEnvironmentDatabase, getDatabase } from "@/lib/environment-store";
import { materializeAutomationRun } from "../route";

export const dynamic = "force-dynamic";

function constantTimeEqual(left: string, right: string) {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

async function signatureFor(secret: string, payload: Uint8Array) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(payload).buffer))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Scheduler-only entrypoint. A compare-and-swap on next_run_at claims each due
 * slot exactly once. Run materialization then uses its own recoverable lease,
 * so a process crash cannot create duplicate tasks or lose the idempotency key.
 */
export async function POST(request: Request) {
  try {
    const secret = process.env.CONDUCTOR_AUTOMATION_SCHEDULER_SECRET?.trim();
    if (!secret) throw new ApiError(503, "automation_scheduler_not_configured", "The scheduler principal is not configured.");
    const raw = new Uint8Array(await request.arrayBuffer());
    const supplied = request.headers.get("x-conductor-scheduler-signature")?.replace(/^sha256=/, "").toLowerCase() ?? "";
    const expected = await signatureFor(secret, raw);
    if (!constantTimeEqual(expected, supplied)) throw new ApiError(401, "automation_scheduler_unauthorized", "Scheduler authentication failed.");

    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    const requestedAt = new Date().toISOString();
    const runsById = new Map<string, unknown>();
    const failures: Array<{ automationId: string; code: string }> = [];

    // A process may stop after reserving a due slot. Recover its exact
    // idempotency key once the materializer lease expires, regardless of the
    // automation's next scheduled time, so no reserved run is orphaned.
    const stale = await database.prepare(
      `SELECT a.*, r.idempotency_key AS recovery_key
       FROM automation_runs r
       JOIN automations a ON a.id = r.automation_id
       WHERE r.status = 'materializing'
         AND r.idempotency_key LIKE 'schedule:%'
         AND (r.lease_expires_at IS NULL OR r.lease_expires_at <= ?)
       ORDER BY r.created_at, r.id
       LIMIT 50`,
    ).bind(requestedAt).all<Record<string, unknown>>();
    for (const automation of stale.results) {
      try {
        const recovered = await materializeAutomationRun(
          database,
          automation,
          String(automation.owner_id),
          String(automation.recovery_key),
        );
        runsById.set(recovered.runId, recovered);
      } catch (error) {
        failures.push({
          automationId: String(automation.id),
          code: error instanceof ApiError ? error.code : "automation_recovery_failed",
        });
      }
    }

    const due = await database.prepare(
      "SELECT * FROM automations WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at, id LIMIT 50",
    ).bind(requestedAt).all<Record<string, unknown>>();
    for (const automation of due.results) {
      const slot = String(automation.next_run_at);
      const trigger = parseAutomationTrigger(JSON.parse(String(automation.trigger_json)));
      const nextRunAt = nextScheduledRun(trigger, new Date(requestedAt));
      if (!nextRunAt) continue;
      try {
        // Reserve/materialize the exact due slot before advancing it. If the
        // process stops at any later point, the due slot remains visible or
        // the stale reservation above is recoverable by its schedule key.
        const materialized = await materializeAutomationRun(
          database,
          automation,
          String(automation.owner_id),
          `schedule:${slot}`,
          { expectedScheduleSlot: slot },
        );
        runsById.set(materialized.runId, materialized);
        const advanced = await database.prepare(
          `UPDATE automations SET next_run_at = ?, updated_at = ?
           WHERE id = ? AND enabled = 1 AND next_run_at = ?
             AND EXISTS (
               SELECT 1 FROM automation_runs
               WHERE automation_id = ? AND idempotency_key = ?
             )`,
        ).bind(nextRunAt, requestedAt, automation.id, slot, automation.id, `schedule:${slot}`).run();
        if ((advanced.meta.changes ?? 0) !== 1) {
          const current = await database.prepare("SELECT enabled, next_run_at FROM automations WHERE id = ?").bind(automation.id).first<{ enabled: number; next_run_at: string | null }>();
          // A concurrent scheduler may already have advanced the same slot.
          // Any other state change is explicit, while the reserved run remains
          // recoverable and cannot be duplicated.
          if (current?.next_run_at !== nextRunAt) {
            failures.push({ automationId: String(automation.id), code: current?.enabled === 0 ? "automation_paused" : "automation_schedule_advance_conflict" });
          }
        }
      } catch (error) {
        failures.push({
          automationId: String(automation.id),
          code: error instanceof ApiError ? error.code : "automation_materialization_failed",
        });
      }
    }

    return jsonResponse({ ok: failures.length === 0, principal: "scheduler", runs: [...runsById.values()], failures }, failures.length ? 207 : 200);
  } catch (error) {
    return errorResponse(error);
  }
}
