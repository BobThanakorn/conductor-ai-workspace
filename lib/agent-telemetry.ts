export type AgentTokenUsage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type AgentToolUse = {
  name: string;
  status: "called" | "completed" | "failed";
};

export type AgentAuditEvent = {
  at: string;
  stage: string;
  detail: string;
};

export type AgentTelemetry = {
  durationMs: number;
  providerDurationMs?: number;
  tokenUsage: AgentTokenUsage;
  tools: AgentToolUse[];
  auditLog: AgentAuditEvent[];
};

export function emptyTokenUsage(): AgentTokenUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}
