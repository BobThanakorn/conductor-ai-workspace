import { ApiError, errorResponse, jsonResponse } from "@/lib/api-contract";
import {
  AgentProviderConfigurationError,
  DEFAULT_AZURE_FOUNDRY_MODEL,
  prefersOpenSourcePrimaryLlm,
  resolveAgentModelOptions,
  resolveAgentRuntimeConfig,
  resolveAzureRuntimeConfig,
} from "@/lib/agent-provider";
import { getEnvironmentBindings } from "@/lib/environment-store";
import { getLangGraphHealth } from "@/lib/langgraph-agent";
import { getHarnessHealth } from "@/lib/external-harness";
import { getOpenHandsHealth } from "@/lib/openhands-harness";
import { engineCapability, type EngineCapability } from "@/lib/engine-capabilities";

export const dynamic = "force-dynamic";

const MODEL_LIST_CAP = 32;
const ENGINE_SOURCES: Record<EngineCapability["id"], string> = {
  "conductor-native": "Conductor",
  "openai-agents": "OpenAI",
  langgraph: "LangChain",
  "pydantic-ai": "PydanticAI",
  crewai: "CrewAI",
  "microsoft-agent-framework": "Microsoft",
  llamaindex: "LlamaIndex",
  haystack: "Haystack",
  "semantic-kernel": "Microsoft",
  openhands: "OpenHands",
};

function withEngineSource(
  engine: EngineCapability & { status: string; codingReady: boolean },
) {
  return { ...engine, source: ENGINE_SOURCES[engine.id] };
}

function prioritizeModels(pinned: string[], models: string[], cap = MODEL_LIST_CAP): string[] {
  const priority = [...new Set(pinned.filter(Boolean))];
  const remainder = models.filter((model) => model && !priority.includes(model));
  return [...priority, ...remainder].slice(0, cap);
}

export async function GET() {
  try {
    const bindings = getEnvironmentBindings();
    const runtime = resolveAgentRuntimeConfig(bindings);
    const vllmModel = bindings.VLLM_MODEL?.trim();
    const vllmBaseURL = bindings.VLLM_BASE_URL?.trim();
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
            .slice(0, MODEL_LIST_CAP);
          // Provider discovery proves that a model identifier is listed, not
          // that this resource can successfully invoke it. Only the configured
          // default is marked ready until an actual inference succeeds.
          for (const model of remoteModels) modelStatus[model] ??= "configured";
          models = prioritizeModels(
            [runtime.model, ...(vllmModel ? [vllmModel] : [])],
            [...remoteModels, ...models],
          );
        }
      } catch {
        // The configured model remains selectable when the provider model list is unavailable.
      }
    }
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
          models = prioritizeModels(
            [...(vllmModel ? [vllmModel] : []), ...remoteVllmModels],
            models,
          );
        }
      } catch {
        // Keep configured/unavailable status when the local provider cannot be reached.
      }
    }
    const azureRuntime = resolveAzureRuntimeConfig(bindings);
    if (azureRuntime) {
      modelStatus[azureRuntime.model] = "ready";
      try {
        const response = await fetch(`${azureRuntime.baseURL}/models`, {
          headers: { Authorization: `Bearer ${azureRuntime.apiKey}`, Accept: "application/json" },
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) {
          const payload = await response.json() as { data?: Array<{ id?: unknown }> };
          const remoteAzureModels = (payload.data ?? [])
            .map((entry) => typeof entry.id === "string" ? entry.id.trim() : "")
            .filter(Boolean)
            .slice(0, MODEL_LIST_CAP);
          for (const model of remoteAzureModels) modelStatus[model] ??= "configured";
          models = prioritizeModels(
            [azureRuntime.model],
            [...remoteAzureModels, ...models],
          );
        }
      } catch {
        // Keep the configured Azure deployment ready when discovery is unavailable.
      }
    } else {
      const azureModel = bindings.AZURE_AI_FOUNDRY_MODEL?.trim() ?? DEFAULT_AZURE_FOUNDRY_MODEL;
      if (models.includes(azureModel)) modelStatus[azureModel] = "unavailable";
    }
    const pinnedReadyModels = [
      ...(vllmModel && modelStatus[vllmModel] === "ready" ? [vllmModel] : []),
      ...(azureRuntime && modelStatus[azureRuntime.model] === "ready" ? [azureRuntime.model] : []),
      ...models.filter((model) => modelStatus[model] === "ready"),
    ];
    models = prioritizeModels(pinnedReadyModels, models);
    for (const model of models) modelStatus[model] ??= "configured";
    const readyModels = models.filter((model) => modelStatus[model] === "ready");
    const readyModelStatus = Object.fromEntries(
      readyModels.map((model) => [model, "ready" as const]),
    );
    let langgraph: {
      ok: boolean;
      engine?: string;
      checkpoint?: string;
      modelConfigured?: boolean;
    } = { ok: false };
    if (bindings.LANGGRAPH_AGENT_URL?.trim()) {
      try {
        langgraph = await getLangGraphHealth(bindings.LANGGRAPH_AGENT_URL.trim());
      } catch {
        langgraph = { ok: false };
      }
    }
    let pydanticAI = { ok: false };
    if (bindings.PYDANTIC_AI_AGENT_URL?.trim()) {
      try {
        pydanticAI = await getHarnessHealth(bindings.PYDANTIC_AI_AGENT_URL.trim());
      } catch {
        pydanticAI = { ok: false };
      }
    }
    let crewAI = { ok: false };
    if (bindings.CREWAI_AGENT_URL?.trim()) {
      try { crewAI = await getHarnessHealth(bindings.CREWAI_AGENT_URL.trim()); } catch { crewAI = { ok: false }; }
    }
    const externalHarnesses = await Promise.all([
      ["microsoft-agent-framework", bindings.MICROSOFT_AGENT_FRAMEWORK_URL],
      ["llamaindex", bindings.LLAMAINDEX_AGENT_URL],
      ["haystack", bindings.HAYSTACK_AGENT_URL],
      ["semantic-kernel", bindings.SEMANTIC_KERNEL_AGENT_URL],
    ].map(async ([id, url]) => {
      const engineId = id as EngineCapability["id"];
      if (!url?.trim()) return withEngineSource(engineCapability(engineId, "unavailable"));
      try {
        const health = await getHarnessHealth(url.trim());
        return withEngineSource(engineCapability(engineId, health.ok ? "ready" : "unavailable"));
      } catch {
        return withEngineSource(engineCapability(engineId, "unavailable"));
      }
    }));
    const openhands = bindings.OPENHANDS_AGENT_URL?.trim()
      ? await getOpenHandsHealth(bindings.OPENHANDS_AGENT_URL.trim()).catch(() => ({ ok: false, ready: false }))
      : { ok: false, ready: false };
    const providers: Array<{ provider: string; model: string; baseURL?: string }> = [];
    if (
      prefersOpenSourcePrimaryLlm(bindings)
      && vllmModel
      && vllmBaseURL
      && modelStatus[vllmModel] === "ready"
    ) {
      providers.push({ provider: "litellm", model: vllmModel, baseURL: vllmBaseURL });
    }
    if (azureRuntime && modelStatus[azureRuntime.model] === "ready") {
      providers.push({
        provider: "azure",
        model: azureRuntime.model,
        baseURL: azureRuntime.baseURL,
      });
    }
    if (!providers.length) {
      providers.push({ provider: runtime.provider, model: runtime.model, ...(runtime.baseURL ? { baseURL: runtime.baseURL } : {}) });
      if (
        bindings.VLLM_MODEL
        && bindings.VLLM_BASE_URL
        && modelStatus[bindings.VLLM_MODEL.trim()] === "ready"
        && bindings.VLLM_MODEL.trim() !== runtime.model
      ) {
        providers.push({
          provider: "vllm",
          model: bindings.VLLM_MODEL.trim(),
          baseURL: bindings.VLLM_BASE_URL.trim(),
        });
      }
    }
    return jsonResponse({
      ok: true,
      provider: runtime.provider,
      model: runtime.model,
      models: readyModels,
      modelStatus: readyModelStatus,
      providers,
      engines: [
        withEngineSource(engineCapability("conductor-native", runtime.provider === "openai" && Boolean(runtime.baseURL) ? "ready" : "unavailable")),
        withEngineSource(engineCapability("openai-agents", "ready")),
        withEngineSource(engineCapability("langgraph", langgraph.ok && langgraph.modelConfigured ? "ready" : "unavailable")),
        withEngineSource(engineCapability("pydantic-ai", pydanticAI.ok ? "ready" : "unavailable")),
        withEngineSource(engineCapability("crewai", crewAI.ok ? "ready" : "unavailable")),
        ...externalHarnesses,
        withEngineSource(engineCapability("openhands", openhands.ok && openhands.ready ? "ready" : "unavailable")),
      ],
    });
  } catch (error) {
    if (error instanceof AgentProviderConfigurationError) {
      return errorResponse(new ApiError(503, "agent_provider_unconfigured", "Configure a model provider before selecting a model."));
    }
    return errorResponse(error);
  }
}
