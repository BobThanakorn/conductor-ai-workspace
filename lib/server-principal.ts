import { ApiError } from "./api-contract.ts";
import { authenticateHandoffIdentity } from "./handoff-identity.ts";

export type ServerPrincipal = {
  actorId: string;
  kind: "trusted-user" | "human";
  workspaceId?: string;
};

const trustedUserId = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/**
 * Browser input can never name an owner. Hosted requests use the platform's
 * authenticated-user header; local use requires a short-lived signed human
 * identity that stays only in page memory.
 */
export async function authenticateServerPrincipal(
  request: Request,
  signingSecret: string | undefined,
  scope?: { workspaceId: string },
): Promise<ServerPrincipal> {
  const platformUser = request.headers.get("oai-authenticated-user-id")?.trim();
  if (platformUser && process.env.CONDUCTOR_TRUST_PLATFORM_IDENTITY === "true") {
    if (!trustedUserId.test(platformUser)) throw new ApiError(401, "authenticated_user_invalid", "The authenticated user identity is invalid.");
    return { actorId: `user:${platformUser.toLowerCase()}`, kind: "trusted-user", ...(scope ? { workspaceId: scope.workspaceId } : {}) };
  }
  const identity = await authenticateHandoffIdentity(request, signingSecret, scope);
  if (identity.kind !== "human") throw new ApiError(403, "human_automation_identity_required", "A signed human identity is required for automation ownership.");
  return { actorId: identity.actorId, kind: "human", workspaceId: identity.workspaceId };
}
