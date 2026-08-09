import process from "node:process";

import { ApiError, errorResponse, jsonResponse } from "@/lib/api-contract";
import { digestGitHubWebhookBody, githubAppConfigFromEnvironment, verifyGitHubWebhook } from "@/lib/github-app";
import { DEFAULT_WORKSPACE_ID, claimIdempotency, completeIdempotency, ensureEnvironmentDatabase, getDatabase } from "@/lib/environment-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const delivery = request.headers.get("x-github-delivery")?.trim();
    const event = request.headers.get("x-github-event")?.trim();
    if (!delivery || !/^[A-Za-z0-9-]{8,128}$/.test(delivery) || !event || !/^[a-z_]{2,64}$/.test(event)) throw new ApiError(400, "github_webhook_delivery_invalid", "GitHub webhook delivery metadata is invalid.");
    const raw = new Uint8Array(await request.arrayBuffer());
    const config = githubAppConfigFromEnvironment(process.env);
    await verifyGitHubWebhook(raw, request.headers.get("x-hub-signature-256"), config.webhookSecret);
    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    const scope = `github-webhook:${delivery}`;
    const requestHash = await digestGitHubWebhookBody(raw);
    const claim = await claimIdempotency(database, scope, delivery, requestHash);
    if (claim.kind === "replay") return jsonResponse(claim.body, claim.status);
    if (claim.kind === "conflict" || claim.kind === "in_progress") throw new ApiError(409, "github_webhook_duplicate", "GitHub webhook delivery was already processed.");
    await database.prepare(
      `INSERT INTO task_events (event_id, workspace_id, task_id, type, actor, summary, payload_json, created_at)
       VALUES (?, ?, NULL, 'github.webhook_accepted', 'github-app', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), DEFAULT_WORKSPACE_ID, "GitHub webhook signature verified and delivery claimed.",
      JSON.stringify({ delivery, event, payloadDigest: requestHash }), new Date().toISOString(),
    ).run();
    const responseBody = { ok: true, delivery, event, accepted: true };
    await completeIdempotency(database, scope, delivery, claim.ownerToken, 202, responseBody);
    return jsonResponse(responseBody, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
