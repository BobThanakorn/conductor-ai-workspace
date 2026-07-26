export const DEFAULT_AZURE_FOUNDRY_ENDPOINT =
  "https://ai-environment-resource.services.ai.azure.com";
export const DEFAULT_AZURE_FOUNDRY_MODEL = "gpt-5.1-codex-mini";

export type AgentEnvironmentBindings = {
  AZURE_AI_FOUNDRY_API_KEY?: string;
  AZURE_AI_FOUNDRY_ENDPOINT?: string;
  AZURE_AI_FOUNDRY_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_AGENT_MODEL?: string;
  OPENAI_MODEL?: string;
  VLLM_BASE_URL?: string;
  VLLM_API_KEY?: string;
  VLLM_MODEL?: string;
  CONDUCTOR_MODEL_OPTIONS?: string;
  MCP_GATEWAY_URL?: string;
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
      baseURL?: string;
      model: string;
    };

export class AgentProviderConfigurationError extends Error {
  constructor() {
    super("No live model provider is configured.");
    this.name = "AgentProviderConfigurationError";
  }
}

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isPrivateNetworkHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".docker.internal") || hostname === "model-runner") {
    return true;
  }
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function normalizeOpenAICompatibleBaseUrl(value: string): string {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && isPrivateNetworkHost(url.hostname);
  if ((!localHttp && url.protocol !== "https:") || url.username || url.password || url.hash || url.search) {
    throw new Error("OpenAI-compatible endpoint must use HTTPS or a trusted private-network model host.");
  }
  return url.toString().replace(/\/$/, "");
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
    const configuredBaseUrl = configured(bindings.OPENAI_BASE_URL);
    let baseURL: string | undefined;
    if (configuredBaseUrl) baseURL = normalizeOpenAICompatibleBaseUrl(configuredBaseUrl);
    return {
      provider: "openai",
      apiKey: openAIKey,
      ...(baseURL ? { baseURL } : {}),
      model:
        configured(bindings.OPENAI_AGENT_MODEL) ??
        configured(bindings.OPENAI_MODEL) ??
        "gpt-5.6-terra",
    };
  }

  throw new AgentProviderConfigurationError();
}

export function resolveAgentRuntimeConfigForModel(
  bindings: AgentEnvironmentBindings,
  requestedModel?: string,
): AgentRuntimeConfig {
  const baseRuntime = resolveAgentRuntimeConfig(bindings);
  const model = configured(requestedModel) ?? baseRuntime.model;
  const vllmModel = configured(bindings.VLLM_MODEL);
  const vllmBaseUrl = configured(bindings.VLLM_BASE_URL);
  if (vllmModel && vllmBaseUrl && model === vllmModel) {
    return {
      provider: "openai",
      apiKey: configured(bindings.VLLM_API_KEY) ?? "EMPTY",
      baseURL: normalizeOpenAICompatibleBaseUrl(vllmBaseUrl),
      model: vllmModel,
    };
  }
  return { ...baseRuntime, model };
}

export function resolveAgentModelOptions(
  bindings: AgentEnvironmentBindings,
  runtime = resolveAgentRuntimeConfig(bindings),
): string[] {
  const configuredOptions = configured(bindings.CONDUCTOR_MODEL_OPTIONS)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 32) ?? [];
  const vllmModel = configured(bindings.VLLM_MODEL);
  return [runtime.model, vllmModel, ...configuredOptions].filter(
    (value): value is string => Boolean(value),
  ).filter(
    (value, index, values) => values.indexOf(value) === index,
  );
}

export function normalizeMcpGatewayUrl(value: string | undefined): string | undefined {
  const configuredValue = configured(value);
  if (!configuredValue) return undefined;
  const url = new URL(configuredValue);
  const trustedLocal = url.protocol === "http:" && ["mcp-gateway", "localhost", "127.0.0.1"].includes(url.hostname);
  if ((!trustedLocal && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("MCP_GATEWAY_URL must use HTTPS or the local Compose MCP gateway hostname.");
  }
  return url.toString().replace(/\/$/, "");
}
