import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AZURE_FOUNDRY_ENDPOINT,
  normalizeAzureFoundryBaseUrl,
  resolveAgentRuntimeConfig,
} from "../lib/agent-provider.ts";

test("prefers the configured Azure Foundry model and normalizes its v1 base URL", () => {
  const runtime = resolveAgentRuntimeConfig({
    AZURE_AI_FOUNDRY_API_KEY: "test-key",
    AZURE_AI_FOUNDRY_ENDPOINT: "https://ai-environment-resource.services.ai.azure.com/",
    AZURE_AI_FOUNDRY_MODEL: "gpt-5.1-codex-mini",
    OPENAI_API_KEY: "legacy-key",
  });

  assert.deepEqual(runtime, {
    provider: "azure",
    apiKey: "test-key",
    baseURL: "https://ai-environment-resource.services.ai.azure.com/openai/v1",
    model: "gpt-5.1-codex-mini",
  });
});

test("uses the supplied Foundry resource when only an Azure key is configured", () => {
  const runtime = resolveAgentRuntimeConfig({ AZURE_AI_FOUNDRY_API_KEY: "test-key" });
  assert.equal(runtime.provider, "azure");
  assert.equal(runtime.provider === "azure" ? runtime.baseURL : "", `${DEFAULT_AZURE_FOUNDRY_ENDPOINT}/openai/v1`);
});

test("rejects a non-Azure endpoint before it can receive an Azure credential", () => {
  assert.throws(
    () => normalizeAzureFoundryBaseUrl("https://example.com/openai/v1"),
    /Azure AI Foundry endpoint/,
  );
});

test("keeps a deterministic demo model when no server credential is configured", () => {
  const runtime = resolveAgentRuntimeConfig({});
  assert.deepEqual(runtime, { provider: "demo", model: "gpt-5.1-codex-mini" });
});
