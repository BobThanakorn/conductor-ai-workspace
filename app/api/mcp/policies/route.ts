import {
  ApiError,
  errorResponse,
  jsonResponse,
  readJsonBody,
  requireIdempotencyKey,
  validationError,
} from "@/lib/api-contract";
import {
  DEFAULT_WORKSPACE_ID,
  ensureEnvironmentDatabase,
  getDatabase,
  getEnvironmentBindings,
} from "@/lib/environment-store";
import { mcpPolicyMutationSchema } from "@/lib/mcp-contract";
import { listMcpPolicySnapshot, mutateMcpPolicy } from "@/lib/mcp-policy";
import { requireMcpAdministrator, type McpRegistryBindings } from "@/lib/mcp-registry";

export const dynamic = "force-dynamic";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function identifier(value: string | null, fallback?: string): string | undefined {
  const normalized = value?.trim() || fallback;
  if (!normalized) return undefined;
  if (!IDENTIFIER.test(normalized)) {
    throw new ApiError(400, "invalid_identifier", "The workspace or agent identifier is invalid.");
  }
  return normalized;
}

function bindings(): McpRegistryBindings {
  return getEnvironmentBindings() as unknown as McpRegistryBindings;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const workspaceId = identifier(url.searchParams.get("workspaceId"), DEFAULT_WORKSPACE_ID)!;
    const agentId = identifier(url.searchParams.get("agentId"));
    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    return jsonResponse({
      ok: true,
      ...(await listMcpPolicySnapshot({ database, workspaceId, ...(agentId ? { agentId } : {}) })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const runtimeBindings = bindings();
    await requireMcpAdministrator(request, runtimeBindings);
    const body = await readJsonBody(request);
    const parsed = mcpPolicyMutationSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    const idempotencyKey = requireIdempotencyKey(request);
    const workspaceId = parsed.data.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    const result = await mutateMcpPolicy({
      database,
      workspaceId,
      input: parsed.data,
      idempotencyKey,
      // The administrator identity is established by the server-side secret.
      // Never accept an actor identity or credential from the mutation body.
      actorId: "mcp-administrator",
    });
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}
