import { ApiError, errorResponse, jsonResponse } from "@/lib/api-contract";
import {
  AgentProviderConfigurationError,
  resolveAgentModelOptions,
  resolveAgentRuntimeConfig,
} from "@/lib/agent-provider";
import { getEnvironmentBindings } from "@/lib/environment-store";
import { getLangGraphHealth } from "@/lib/langgraph-agent";
import { getHarnessHealth } from "@/lib/external-harness";

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
      ["microsoft-agent-framework", "Microsoft Agent Framework", bindings.MICROSOFT_AGENT_FRAMEWORK_URL],
      ["llamaindex", "LlamaIndex", bindings.LLAMAINDEX_AGENT_URL],
      ["haystack", "Haystack", bindings.HAYSTACK_AGENT_URL],
      ["semantic-kernel", "Semantic Kernel", bindings.SEMANTIC_KERNEL_AGENT_URL],
    ].map(async ([id, name, url]) => {
      if (!url?.trim()) return { id, name, status: "unavailable" };
      try {
        const health = await getHarnessHealth(url.trim());
        return { id, name, status: health.ok ? "ready" : "unavailable" };
      } catch {
        return { id, name, status: "unavailable" };
      }
    }));
    return jsonResponse({
      ok: true,
      provider: runtime.provider,
      model: runtime.model,
      models: readyModels,
      modelStatus: readyModelStatus,
      providers: [
        { provider: runtime.provider, model: runtime.model },
        ...(bindings.VLLM_MODEL
          && bindings.VLLM_BASE_URL
          && modelStatus[bindings.VLLM_MODEL.trim()] === "ready"
          ? [{ provider: "vllm", model: bindings.VLLM_MODEL, baseURL: bindings.VLLM_BASE_URL }]
          : []),
      ],
      engines: [
        { id: "openai-agents", name: "OpenAI Agents SDK", status: "ready" },
        {
          id: "langgraph",
          name: "LangChain + LangGraph",
          status: langgraph.ok && langgraph.modelConfigured ? "ready" : "unavailable",
        },
        {
          id: "pydantic-ai",
          name: "PydanticAI",
          status: pydanticAI.ok ? "ready" : "unavailable",
        },
        { id: "crewai", name: "CrewAI", status: crewAI.ok ? "ready" : "unavailable" },
        ...externalHarnesses,
      ],
    });
  } catch (error) {
    if (error instanceof AgentProviderConfigurationError) {
      return errorResponse(new ApiError(503, "agent_provider_unconfigured", "Configure a model provider before selecting a model."));
    }
    return errorResponse(error);
  }
}
