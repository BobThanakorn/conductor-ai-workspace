import process from "node:process";
import { z } from "zod";

import { ApiError, errorResponse, jsonResponse, readJsonBody, requireIdempotencyKey, validationError } from "@/lib/api-contract";
import { authenticateHandoffIdentity } from "@/lib/handoff-identity";
import { GitHubAppClient, githubAppConfigFromEnvironment, verifyPublicationPermit } from "@/lib/github-app";
import { canonicalRequest, claimIdempotency, digest, ensureEnvironmentDatabase, getDatabase } from "@/lib/environment-store";

export const dynamic = "force-dynamic";

const mergeSchema = z.object({
  permit: z.string().trim().min(32).max(8_192),
  workspaceId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  installationId: z.number().int().positive(),
  repository: z.string().trim().max(260),
  sourceRef: z.string().trim().max(240),
  headSha: z.string().trim().max(64),
  targetBranch: z.string().trim().max(240),
  pullNumber: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
}).strict();

/**
 * Performs the protected GitHub PR merge. This deliberately has no companion
 * equivalent: only the server may obtain a request-scoped installation token.
 */
export async function POST(request: Request) {
  try {
    const parsed = mergeSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw validationError(parsed.error);
    const { permit, idempotencyKey: bodyKey, ...input } = parsed.data;
    const idempotencyKey = requireIdempotencyKey(request, bodyKey);
    const config = githubAppConfigFromEnvironment(process.env);
    const principal = await authenticateHandoffIdentity(request, process.env.CONDUCTOR_HANDOFF_SIGNING_SECRET, { workspaceId: input.workspaceId });
    if (principal.kind !== "human") throw new ApiError(403, "human_publication_identity_required", "A server-verified human identity is required to merge a protected pull request.");

    // Do not persist the bearer-like permit. Its verified ID provides a durable
    // one-time publication scope while audit records contain only safe metadata.
    const verified = await verifyPublicationPermit(permit, { ...input, actorId: principal.actorId }, config.publicationSigningSecret);
    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    const scope = `github-publication:${input.workspaceId}:${verified.permitId}`;
    const requestHash = await digest(canonicalRequest({ actorId: principal.actorId, input, idempotencyKey, permitId: verified.permitId }));
    const claim = await claimIdempotency(database, scope, "merge", requestHash);
    if (claim.kind === "replay") return jsonResponse(claim.body, claim.status);
    if (claim.kind === "conflict" || claim.kind === "in_progress") {
      throw new ApiError(409, "publication_merge_duplicate", "This one-time publication permit is already being used or was used for a different merge request.");
    }

    // This method performs the fresh provider revalidation and merge as one
    // request-scoped operation. GitHub additionally receives the reviewed SHA.
    const merged = await new GitHubAppClient(config).mergeProtectedPullRequest(input, verified.policyDigest);
    const body = {
      ok: true,
      merged: true,
      repository: merged.repository,
      pullNumber: input.pullNumber,
      mergeSha: merged.mergeSha,
      policyDigest: merged.policyDigest,
      ...(merged.reconciled ? { reconciled: true } : {}),
    };
    await database.batch([
      database.prepare(
        `INSERT INTO task_events (event_id, workspace_id, task_id, type, actor, summary, payload_json, created_at)
         VALUES (?, ?, NULL, 'github.publication_merged', ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), input.workspaceId, principal.actorId, "Protected GitHub pull request merged after permit and policy revalidation.",
        JSON.stringify({ permitId: verified.permitId, installationId: input.installationId, repository: merged.repository, pullNumber: input.pullNumber, sourceRef: input.sourceRef, headSha: input.headSha, targetBranch: input.targetBranch, mergeSha: merged.mergeSha, policyDigest: merged.policyDigest, reconciled: merged.reconciled }),
        new Date().toISOString(),
      ),
      database.prepare(
        `UPDATE idempotency_keys
         SET status = 'completed', response_status = ?, response_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE scope = ? AND key = ? AND owner_token = ?`,
      ).bind(200, JSON.stringify(body), scope, "merge", claim.ownerToken),
    ]);
    return jsonResponse(body);
  } catch (error) {
    return errorResponse(error);
  }
}
