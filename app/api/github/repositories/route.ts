import process from "node:process";

import { ApiError, errorResponse, jsonResponse } from "@/lib/api-contract";
import { DEFAULT_WORKSPACE_ID } from "@/lib/environment-store";
import { GitHubAppClient, githubAppConfigFromEnvironment } from "@/lib/github-app";
import { authenticateServerPrincipal } from "@/lib/server-principal";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const installationId = Number(url.searchParams.get("installationId"));
    const workspaceId = url.searchParams.get("workspaceId")?.trim() || DEFAULT_WORKSPACE_ID;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workspaceId)) {
      throw new ApiError(400, "github_workspace_invalid", "workspaceId is invalid.");
    }
    // Repository discovery is not a public capability: the server principal is
    // established by the hosting identity or a signed human token, never by an
    // actor supplied in a query string or request body.
    await authenticateServerPrincipal(
      request,
      process.env.CONDUCTOR_HANDOFF_SIGNING_SECRET,
      { workspaceId },
    );
    const client = new GitHubAppClient(githubAppConfigFromEnvironment(process.env));
    const repositories = await client.listInstallationRepositories(installationId);
    return jsonResponse({ ok: true, workspaceId, installationId, repositories });
  } catch (error) {
    return errorResponse(error instanceof ApiError ? error : new ApiError(500, "github_repositories_failed", "GitHub repositories could not be loaded."));
  }
}
