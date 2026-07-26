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
    let models = resolveAgentModelOptions(bindings, runtime);
    if (runtime.baseURL) {
      try {
        const response = await fetch(`${runtime.baseURL}/models`, {
          headers: { Authorization: `Bearer ${runtime.apiKey}`, Accept: "application/json" },
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) {
          const payload = await response.json() as { data?: Array<{ id?: unknown }> };
          const remoteModels = (payload.data ?? [])
            .map((entry) => typeof entry.id === "string" ? entry.id.trim() : "")
            .filter(Boolean)
            .slice(0, 32);
          models = [...new Set([runtime.model, ...remoteModels, ...models])].slice(0, 32);
        }
      } catch {
        // The configured model remains selectable when the provider model list is unavailable.
      }
    }
    return jsonResponse({
      ok: true,
      provider: runtime.provider,
      model: runtime.model,
      models,
      providers: [
        { provider: runtime.provider, model: runtime.model },
        ...(bindings.VLLM_MODEL && bindings.VLLM_BASE_URL
          ? [{ provider: "vllm", model: bindings.VLLM_MODEL, baseURL: bindings.VLLM_BASE_URL }]
          : []),
      ],
    });
  } catch (error) {
    if (error instanceof AgentProviderConfigurationError) {
      return errorResponse(new ApiError(503, "agent_provider_unconfigured", "Configure a model provider before selecting a model."));
    }
    return errorResponse(error);
  }
}
