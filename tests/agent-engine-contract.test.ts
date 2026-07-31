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
