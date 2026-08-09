import process from "node:process";
import { z } from "zod";

import { ApiError, errorResponse, jsonResponse, readJsonBody, validationError } from "@/lib/api-contract";
import { authenticateHandoffIdentity } from "@/lib/handoff-identity";
import { GitHubAppClient, githubAppConfigFromEnvironment, verifyPublicationPermit } from "@/lib/github-app";
import { ensureEnvironmentDatabase, getDatabase } from "@/lib/environment-store";

export const dynamic = "force-dynamic";

const verifySchema = z.object({
  permit: z.string().trim().min(32).max(8_192),
  workspaceId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  installationId: z.number().int().positive(),
  repository: z.string().trim().max(260),
  sourceRef: z.string().trim().max(240),
  headSha: z.string().trim().max(64),
  targetBranch: z.string().trim().max(240),
  pullNumber: z.number().int().positive(),
}).strict();

// This endpoint deliberately performs no GitHub mutation. A future publisher
// must call it immediately before its own server-side mutation, and direct
// companion publication remains retired until such a publisher is added.
export async function POST(request: Request) {
  try {
    const parsed = verifySchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw validationError(parsed.error);
    const { permit, ...input } = parsed.data;
    const config = githubAppConfigFromEnvironment(process.env);
    const principal = await authenticateHandoffIdentity(request, process.env.CONDUCTOR_HANDOFF_SIGNING_SECRET, { workspaceId: input.workspaceId });
    if (principal.kind !== "human") throw new ApiError(403, "human_publication_identity_required", "A server-verified human identity is required to verify a publication permit.");
    const validation = await new GitHubAppClient(config).validatePublication(input);
    const verified = await verifyPublicationPermit(permit, { ...input, actorId: principal.actorId }, config.publicationSigningSecret);
    if (verified.policyDigest !== validation.policyDigest) throw new ApiError(409, "publication_policy_changed", "GitHub branch, check, or review policy changed after the permit was issued.");
    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    await database.prepare(
      `INSERT INTO task_events (event_id, workspace_id, task_id, type, actor, summary, payload_json, created_at)
       VALUES (?, ?, NULL, 'github.publication_permit_verified', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), input.workspaceId, principal.actorId, "GitHub App publication permit revalidated against fresh provider policy.",
      JSON.stringify({ permitId: verified.permitId, installationId: input.installationId, repository: validation.repository.fullName, sourceRef: input.sourceRef, headSha: input.headSha, targetBranch: input.targetBranch, pullNumber: input.pullNumber, policyDigest: validation.policyDigest }),
      new Date().toISOString(),
    ).run();
    return jsonResponse({ ok: true, permitVerified: true, verificationOnly: true, expiresAt: new Date(verified.expiresAt * 1000).toISOString() });
  } catch (error) {
    return errorResponse(error);
  }
}
