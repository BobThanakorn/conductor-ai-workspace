import {
  ApiError,
  errorResponse,
  jsonResponse,
  readJsonBody,
  validationError,
} from "@/lib/api-contract";
import {
  DEFAULT_WORKSPACE_ID,
  ensureEnvironmentDatabase,
  getDatabase,
  getEnvironmentBindings,
} from "@/lib/environment-store";
import { mcpServerActionSchema } from "@/lib/mcp-contract";
import {
  executeMcpServerAction,
  listMcpRegistrationOptions,
  listMcpRegistryEvents,
  listMcpServers,
  registerMcpServer,
  requireMcpAdministrator,
  type McpRegistryBindings,
} from "@/lib/mcp-registry";

export const dynamic = "force-dynamic";

function registryBindings(): McpRegistryBindings {
  return getEnvironmentBindings() as unknown as McpRegistryBindings;
}

function workspaceIdFromUrl(request: Request): string {
  const value = new URL(request.url).searchParams.get("workspaceId")?.trim() || DEFAULT_WORKSPACE_ID;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new ApiError(400, "invalid_workspace_id", "The workspace ID is invalid.");
  }
  return value;
}

export async function GET(request: Request) {
  try {
    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    const bindings = registryBindings();
    const workspaceId = workspaceIdFromUrl(request);
    return jsonResponse({
      ok: true,
      workspaceId,
      registrationOptions: listMcpRegistrationOptions(bindings),
      servers: await listMcpServers(database, workspaceId),
      events: await listMcpRegistryEvents(database, workspaceId),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readJsonBody(request);
    const parsed = mcpServerActionSchema.safeParse(body);
    if (!parsed.success) throw validationError(parsed.error);
    const input = parsed.data;
    const bindings = registryBindings();
    await requireMcpAdministrator(request, bindings);
    const database = getDatabase();
    await ensureEnvironmentDatabase(database);
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const server = input.action === "register"
      ? await registerMcpServer({
          database,
          workspaceId,
          allowlistId: input.allowlistId,
          bindings,
        })
      : await executeMcpServerAction({
          database,
          workspaceId,
          action: input.action,
          serverId: input.serverId,
          bindings,
        });
    return jsonResponse({ ok: true, server });
  } catch (error) {
    return errorResponse(error);
  }
}
