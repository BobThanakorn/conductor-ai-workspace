export const DEFAULT_AZURE_FOUNDRY_ENDPOINT =
  "https://ai-environment-resource.services.ai.azure.com";
export const DEFAULT_AZURE_FOUNDRY_MODEL = "gpt-5.1-codex-mini";

export type AgentEnvironmentBindings = {
  AZURE_AI_FOUNDRY_API_KEY?: string;
  AZURE_AI_FOUNDRY_ENDPOINT?: string;
  AZURE_AI_FOUNDRY_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_AGENT_MODEL?: string;
  OPENAI_MODEL?: string;
};

export type AgentRuntimeConfig =
  | {
      provider: "azure";
      apiKey: string;
      baseURL: string;
      model: string;
    }
  | {
      provider: "openai";
      apiKey: string;
      model: string;
    }
  | {
      provider: "demo";
      model: string;
    };

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function normalizeAzureFoundryBaseUrl(endpoint: string): string {
  const url = new URL(endpoint);
  const host = url.hostname.toLowerCase();
  const isFoundryHost = host.endsWith(".services.ai.azure.com") || host.endsWith(".openai.azure.com");

  if (url.protocol !== "https:" || !isFoundryHost || url.username || url.password || url.search || url.hash) {
    throw new Error("Azure AI Foundry endpoint must be an HTTPS Azure Foundry resource URL.");
  }

  const path = url.pathname.replace(/\/+$/, "");
  if (path && path !== "/openai/v1") {
    throw new Error("Azure AI Foundry endpoint must not include a project or deployment path.");
  }

  return `${url.origin}/openai/v1`;
}

export function resolveAgentRuntimeConfig(bindings: AgentEnvironmentBindings): AgentRuntimeConfig {
  const azureKey = configured(bindings.AZURE_AI_FOUNDRY_API_KEY);
  if (azureKey) {
    return {
      provider: "azure",
      apiKey: azureKey,
      baseURL: normalizeAzureFoundryBaseUrl(
        configured(bindings.AZURE_AI_FOUNDRY_ENDPOINT) ?? DEFAULT_AZURE_FOUNDRY_ENDPOINT,
      ),
      model: configured(bindings.AZURE_AI_FOUNDRY_MODEL) ?? DEFAULT_AZURE_FOUNDRY_MODEL,
    };
  }

  const openAIKey = configured(bindings.OPENAI_API_KEY);
  if (openAIKey) {
    return {
      provider: "openai",
      apiKey: openAIKey,
      model:
        configured(bindings.OPENAI_AGENT_MODEL) ??
        configured(bindings.OPENAI_MODEL) ??
        "gpt-5.6-terra",
    };
  }

  return {
    provider: "demo",
    model:
      configured(bindings.AZURE_AI_FOUNDRY_MODEL) ??
      configured(bindings.OPENAI_AGENT_MODEL) ??
      configured(bindings.OPENAI_MODEL) ??
      DEFAULT_AZURE_FOUNDRY_MODEL,
  };
}
