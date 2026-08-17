import assert from "node:assert/strict";
import test from "node:test";

import { engineCapability } from "../lib/engine-capabilities.ts";

test("only verified tool-loop engines are coding-ready", () => {
  assert.equal(engineCapability("openai-agents", "ready").codingReady, true);
  assert.equal(engineCapability("langgraph", "ready").codingReady, true);
  assert.equal(engineCapability("pydantic-ai", "ready").codingReady, true);

  for (const id of ["crewai", "microsoft-agent-framework", "semantic-kernel"] as const) {
    const capability = engineCapability(id, "ready");
    assert.equal(capability.class, "ask-only");
    assert.equal(capability.toolLoop, false);
    assert.equal(capability.codingReady, false);
  }

  for (const id of ["llamaindex", "haystack"] as const) {
    const capability = engineCapability(id, "ready");
    assert.equal(capability.class, "retrieval");
    assert.equal(capability.codingReady, false);
  }
});

test("health readiness does not override missing agentic capability", () => {
  assert.equal(engineCapability("openai-agents", "configured").codingReady, false);
  assert.equal(engineCapability("langgraph", "unavailable").codingReady, false);
  assert.equal(engineCapability("haystack", "ready").status, "ready");
});
