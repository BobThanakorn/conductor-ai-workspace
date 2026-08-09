import process from "node:process";
import { z } from "zod";

import { ApiError, errorResponse, jsonResponse, readJsonBody, validationError } from "@/lib/api-contract";
import { authenticateHandoffIdentity } from "@/lib/handoff-identity";
import { GitHubAppClient, githubAppConfigFromEnvironment, issuePublicationPermit } from "@/lib/github-app";
import { ensureEnvironmentDatabase, getDatabase } from "@/lib/environment-store";

export const dynamic = "force-dynamic";

const publicationSchema = z.object({
  workspaceId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  installationId: z.number().int().positive(),
  repository: z.string().trim().max(260),
  sourceRef: z.string().trim().max(240),
  headSha: z.string().trim().max(64),
  targetBranch: z.string().trim().max(240),
  pullNumber: z.number().int().positive(),
}).strict();

export async function POST(request: Request) {
  try {
    const parsed = publicationSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) throw validationError(parsed.error);
    const input = parsed.data;
    const config = githubAppConfigFromEnvironment(process.env);
    const principal = await authenticateHandoffIdentity(request, process.env.CONDUCTOR_HANDOFF_SIGNING_SECRET, { workspaceId: input.workspaceId });
    if (principal.kind !== "human") throw new ApiError(403, "human_publication_identity_required", "A server-verified human identity is required to issue a publication permit.");
    const client = new GitHubAppClient(config);
    const validation = await client.validatePublication(input);
    const permit = await issuePublicationPermit({ ...input, actorId: principal.actorId, policyDigest: validation.policyDigest }, config.publicationSigningSecret);
    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    await database.prepare(
      `INSERT INTO task_events (event_id, workspace_id, task_id, type, actor, summary, payload_json, created_at)
       VALUES (?, ?, NULL, 'github.publication_permit_issued', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), input.workspaceId, principal.actorId, "GitHub App publication permit issued after fresh policy verification.",
      JSON.stringify({ installationId: input.installationId, repository: validation.repository.fullName, sourceRef: input.sourceRef, headSha: input.headSha, targetBranch: input.targetBranch, pullNumber: input.pullNumber, policyDigest: validation.policyDigest }),
      new Date().toISOString(),
    ).run();
    return jsonResponse({ ok: true, permit, expiresInSeconds: 300, repository: validation.repository.fullName, policy: validation.policy });
  } catch (error) {
    return errorResponse(error);
  }
}
