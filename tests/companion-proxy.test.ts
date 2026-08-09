import assert from "node:assert/strict";
import test from "node:test";

import {
  isAllowedCompanionRoute,
  proxyCompanionRequest,
} from "../app/api/companion/[...path]/route.ts";

test("companion proxy has a small explicit route allowlist", () => {
  assert.equal(isAllowedCompanionRoute("GET", ["health"]), true);
  assert.equal(isAllowedCompanionRoute("POST", ["terminal", "execute-batch"]), true);
  assert.equal(isAllowedCompanionRoute("POST", ["git", "action"]), false);
  assert.equal(isAllowedCompanionRoute("POST", ["provider", "github", "repository"]), false);
  assert.equal(isAllowedCompanionRoute("GET", ["anything", "else"]), false);
});

test("companion proxy forwards only the bounded approval header and exact body", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url?: string; headers?: Headers; body?: unknown } = {};
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: new Headers(init?.headers), body: init?.body };
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  };
  try {
    const response = await proxyCompanionRequest(new Request("http://web/api/companion/fs/write", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-conductor-approval": "payload-bound-permit",
        authorization: "Bearer must-not-forward",
        cookie: "must-not-forward",
      },
      body: JSON.stringify({ files: [{ path: "safe.txt", content: "ok" }] }),
    }), ["fs", "write"]);
    assert.equal(response.status, 200);
    assert.equal(captured.url, "http://companion:8765/fs/write");
    assert.equal(captured.headers?.get("x-conductor-approval"), "payload-bound-permit");
    assert.equal(captured.headers?.get("authorization"), null);
    assert.equal(captured.headers?.get("cookie"), null);
    assert.equal(captured.headers?.get("content-type"), "application/json");
    assert.deepEqual(JSON.parse(captured.body as string), { files: [{ path: "safe.txt", content: "ok" }] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("companion proxy rejects publication paths and oversized bodies before transport", async () => {
  const retired = await proxyCompanionRequest(new Request("http://web/api/companion/git/action", { method: "POST", body: "{}" }), ["git", "action"]);
  assert.equal(retired.status, 404);
  const oversized = await proxyCompanionRequest(new Request("http://web/api/companion/fs/write", {
    method: "POST",
    body: "x".repeat(4_500_001),
  }), ["fs", "write"]);
  assert.equal(oversized.status, 413);
});
