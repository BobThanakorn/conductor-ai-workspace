import { z } from "zod";

import type { AgentToolUse } from "./agent-telemetry.ts";

export const agentToolRiskSchema = z.enum(["read", "write", "execute", "external"]);
export type AgentToolRisk = z.infer<typeof agentToolRiskSchema>;

export const agentToolEventSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    status: z.enum(["called", "completed", "failed"]),
    source: z.enum(["model", "mcp", "companion", "framework"]),
    risk: agentToolRiskSchema,
    approved: z.boolean(),
  })
  .strict();

export type AgentToolEvent = z.infer<typeof agentToolEventSchema>;

const READ_TOOL_PATTERN = /(?:^|[._:-])(get|list|read|search|fetch|inspect|view|query|status|diff|log)(?:$|[._:-])/i;
const WRITE_TOOL_PATTERN = /(?:^|[._:-])(write|edit|modify|apply|delete|rename|install|commit|push|pull|merge|publish|deploy|create|upload|send)(?:$|[._:-])/i;
const EXECUTE_TOOL_PATTERN = /(?:^|[._:-])(run|execute|terminal|shell|command|process)(?:$|[._:-])/i;
const SECRET_PATTERN = /(?:\bsk-[A-Za-z0-9_-]{12,}\b|\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b|-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,})/gi;

export function classifyAgentToolRisk(name: string): AgentToolRisk {
  const normalized = name.trim();
  if (EXECUTE_TOOL_PATTERN.test(normalized)) return "execute";
  if (WRITE_TOOL_PATTERN.test(normalized)) return "write";
  if (READ_TOOL_PATTERN.test(normalized)) return "read";
  return "external";
}

export function normalizeAgentToolEvent(input: AgentToolUse): AgentToolEvent {
  const name = input.name.trim().slice(0, 240) || "unknown_tool";
  const source = input.source ?? (/mcp/i.test(name) ? "mcp" : "framework");
  const risk = input.risk ?? classifyAgentToolRisk(name);
  // A model/framework event is never authorization. Only a separately issued
  // companion token may set approval during execution, not during planning.
  return agentToolEventSchema.parse({
    name,
    status: input.status,
    source,
    risk,
    approved: input.approved === true && risk === "read",
  });
}

export function normalizeAgentToolEvents(inputs: readonly AgentToolUse[]): AgentToolEvent[] {
  return inputs.map(normalizeAgentToolEvent);
}

export function toolRequiresApproval(event: AgentToolEvent): boolean {
  return event.risk !== "read";
}

export type AgentToolFailure = {
  code: "tool_invalid" | "tool_denied" | "tool_failed";
  message: string;
  tool: string;
};

export function normalizeToolFailure(input: unknown, tool: string): AgentToolFailure {
  const message = (input instanceof Error ? input.message : typeof input === "string" ? input : "Tool failed.")
    .replace(SECRET_PATTERN, "[redacted-secret]")
    .slice(0, 500);
  return {
    code: "tool_failed",
    message,
    tool: tool.trim().slice(0, 240) || "unknown_tool",
  };
}
