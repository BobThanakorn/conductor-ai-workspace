import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent API contract exposes only the two implemented engines", async () => {
  const source = await readFile(new URL("../lib/api-contract.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /engine:\s*z\.enum\(\["openai-agents",\s*"langgraph"\]\)\.default\("openai-agents"\)/,
  );
  assert.doesNotMatch(source, /mock-agent/);
});

test("the API dispatches LangGraph requests to the live service adapter", async () => {
  const source = await readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8");
  assert.match(source, /input\.engine === "langgraph"/);
  assert.match(source, /runLangGraphAgent\(/);
  assert.match(source, /LANGGRAPH_AGENT_URL/);
});

test("both engines return and persist the shared Agent telemetry contract", async () => {
  const [route, store, telemetry] = await Promise.all([
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/environment-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/agent-telemetry.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /tokenUsage:\s*\{/);
  assert.match(route, /tools,/);
  assert.match(route, /auditLog:\s*\[/);
  assert.match(route, /providerDurationMs/);
  assert.match(store, /INSERT OR IGNORE INTO agent_run_audit/);
  assert.match(store, /agent_run_audit_no_update/);
  assert.match(store, /agent_run_audit_no_delete/);
  assert.match(telemetry, /inputTokens/);
  assert.match(telemetry, /outputTokens/);
  assert.match(telemetry, /totalTokens/);
});
