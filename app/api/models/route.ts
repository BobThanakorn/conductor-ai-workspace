import { ApiError, errorResponse, jsonResponse } from "@/lib/api-contract";
import {
  AgentProviderConfigurationError,
  resolveAgentModelOptions,
  resolveAgentRuntimeConfig,
} from "@/lib/agent-provider";
import { getEnvironmentBindings } from "@/lib/environment-store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const bindings = getEnvironmentBindings();
    const runtime = resolveAgentRuntimeConfig(bindings);
    return jsonResponse({
      ok: true,
      provider: runtime.provider,
      model: runtime.model,
      models: resolveAgentModelOptions(bindings, runtime),
    });
  } catch (error) {
    if (error instanceof AgentProviderConfigurationError) {
      return errorResponse(new ApiError(503, "agent_provider_unconfigured", "Configure a model provider before selecting a model."));
    }
    return errorResponse(error);
  }
}
