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
    const modelStatus: Record<string, "ready" | "configured" | "unavailable"> = {};
    modelStatus[runtime.model] = "ready";
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
          // Provider discovery proves that a model identifier is listed, not
          // that this resource can successfully invoke it. Only the configured
          // default is marked ready until an actual inference succeeds.
          for (const model of remoteModels) modelStatus[model] ??= "configured";
          models = [...new Set([runtime.model, ...remoteModels, ...models])].slice(0, 32);
        }
      } catch {
        // The configured model remains selectable when the provider model list is unavailable.
      }
    }
    const vllmModel = bindings.VLLM_MODEL?.trim();
    const vllmBaseURL = bindings.VLLM_BASE_URL?.trim();
    if (vllmModel) modelStatus[vllmModel] = "configured";
    if (vllmModel && vllmBaseURL) {
      try {
        const response = await fetch(`${vllmBaseURL.replace(/\/$/, "")}/models`, {
          headers: { Authorization: `Bearer ${bindings.VLLM_API_KEY?.trim() ?? "EMPTY"}`, Accept: "application/json" },
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) {
          const payload = await response.json() as { data?: Array<{ id?: unknown }> };
          const remoteVllmModels: string[] = [];
          for (const entry of payload.data ?? []) {
            if (typeof entry.id === "string" && entry.id.trim()) {
              const id = entry.id.trim();
              modelStatus[id] = "ready";
              remoteVllmModels.push(id);
            }
          }
          if (vllmModel && modelStatus[vllmModel] !== "ready") modelStatus[vllmModel] = "unavailable";
          models = [...new Set([...models, ...remoteVllmModels])].slice(0, 32);
        }
      } catch {
        // Keep configured/unavailable status when the local provider cannot be reached.
      }
    }
    for (const model of models) modelStatus[model] ??= "configured";
    return jsonResponse({
      ok: true,
      provider: runtime.provider,
      model: runtime.model,
      models,
      modelStatus,
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
