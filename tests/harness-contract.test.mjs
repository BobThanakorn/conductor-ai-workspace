import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const engines = [
  ["pydantic-ai", "agent-pydanticai"],
  ["crewai", "agent-crewai"],
  ["microsoft-agent-framework", "agent-microsoft-framework"],
  ["llamaindex", "agent-llamaindex"],
  ["haystack", "agent-haystack"],
  ["semantic-kernel", "agent-semantic-kernel"],
];

test("native harness services return a proposal contract for Agent mode", { skip: process.env.CONDUCTOR_LIVE_HARNESS_TEST !== "1" ? "set CONDUCTOR_LIVE_HARNESS_TEST=1 with Docker Compose running" : false }, () => {
  for (const [engine, service] of engines) {
    const python = `
import json, urllib.request
engine = ${JSON.stringify(engine)}
message = "Create file work/harness-contract-" + engine + ".txt with content: \\"probe\\"\\npython3 -c \\"print(1)\\""
payload = {"message": message, "model": "gpt-5.1-codex-mini", "mode": "agent", "workspace_files": []}
request = urllib.request.Request("http://127.0.0.1:8020/v1/agent", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
with urllib.request.urlopen(request, timeout=120) as response:
    body = json.load(response)
proposal = body.get("proposal") or {}
print(json.dumps({"engine": body.get("engine"), "ok": body.get("ok"), "hasProposal": bool(body.get("proposal")), "artifacts": len(proposal.get("artifacts", [])), "executions": len(proposal.get("executions", [])), "risk": proposal.get("riskLevel"), "needsApproval": proposal.get("needsApproval") }))
`;
    const output = execFileSync("docker", [
      "compose", "-f", "compose.yaml", "-f", "compose.harnesses.yaml",
      "exec", "-T", service, "python", "-c", python,
    ], { encoding: "utf8", timeout: 150_000 });
    const line = output.trim().split(/\r?\n/).at(-1);
    const result = JSON.parse(line);
    assert.equal(result.ok, true, `${engine} did not return ok`);
    assert.equal(result.engine, engine);
    assert.equal(result.hasProposal, true, `${engine} did not return proposal`);
    assert.equal(result.artifacts, 1, `${engine} proposal artifact count`);
    assert.equal(result.executions, 1, `${engine} proposal execution count`);
    assert.equal(result.risk, "R1");
    assert.equal(result.needsApproval, true);
  }
});
