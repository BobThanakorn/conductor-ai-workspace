import type { AgentRuntimeConfig } from "./agent-provider.ts";
import type { AgentToolUse } from "./agent-telemetry.ts";
import { agentProposalSchema, redactSensitiveText, type AgentProposal } from "./agent-safety.ts";

export type ExternalHarnessId =
  | "pydantic-ai"
  | "microsoft-agent-framework"
  | "crewai"
  | "llamaindex"
  | "haystack"
  | "semantic-kernel";

function coerceProposal(value: unknown): AgentProposal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const asList = (item: unknown) => Array.isArray(item) ? item : typeof item === "string" && item.trim() ? [item] : [];
  const cleanCommand = (command: string) => command.replace(/\\"/g, '"').trim();
  const normalizeExecution = (item: unknown) => {
    if (typeof item === "string" && item.trim()) return { command: cleanCommand(item), args: [], timeoutMs: 120_000 };
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const execution = item as Record<string, unknown>;
      return {
        ...(typeof execution.entrypoint === "string" ? { entrypoint: execution.entrypoint } : {}),
        ...(typeof execution.command === "string" ? { command: cleanCommand(execution.command) } : {}),
        args: Array.isArray(execution.args) ? execution.args.filter((arg): arg is string => typeof arg === "string") : [],
        timeoutMs: typeof execution.timeoutMs === "number" ? execution.timeoutMs : 120_000,
      };
    }
    return item;
  };
  const normalized = {
    ...candidate,
    plan: asList(candidate.plan),
    evidence: asList(candidate.evidence),
    artifacts: Array.isArray(candidate.artifacts) ? candidate.artifacts : [],
    execution: normalizeExecution(candidate.execution),
    executions: Array.isArray(candidate.executions) ? candidate.executions.map(normalizeExecution) : [],
    proposedAction: typeof candidate.proposedAction === "string" && candidate.proposedAction.trim() ? candidate.proposedAction : "read_only_answer",
    riskLevel: ["R0", "R1", "R2", "R3"].includes(String(candidate.riskLevel)) ? candidate.riskLevel : "R0",
    needsApproval: candidate.needsApproval === true,
    summary: typeof candidate.summary === "string" ? candidate.summary : "",
  };
  const parsed = agentProposalSchema.safeParse(normalized);
  return parsed.success ? parsed.data : undefined;
}

export async function getHarnessHealth(serviceUrl: string) {
  const response = await fetch(`${serviceUrl.replace(/\/$/, "")}/health`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) return { ok: false };
  return response.json() as Promise<{ ok: boolean; engine?: string; version?: string }>;
}

export async function runExternalHarness(args: {
  serviceUrl: string;
  engine: ExternalHarnessId;
  runtime: AgentRuntimeConfig;
  message: string;
  mode: "agent" | "ask";
  workspaceFiles: Array<{ path: string; content: string }>;
}) {
  const request = JSON.stringify({
    message: redactSensitiveText(args.message),
    mode: args.mode,
    model: args.runtime.model,
    workspace_files: args.workspaceFiles.map((file) => ({ ...file, content: redactSensitiveText(file.content) })),
  });
  let response: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(`${args.serviceUrl.replace(/\/$/, "")}/v1/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: request,
        signal: AbortSignal.timeout(120_000),
      });
      if (response.status < 500 || attempt === 1) break;
    } catch (error) {
      lastError = error;
      if (attempt === 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!response) throw lastError instanceof Error ? lastError : new Error(`${args.engine} did not return a response.`);
  const payload = await response.json() as {
    ok?: boolean;
    answer?: string;
    proposal?: unknown;
    metrics?: { durationMs?: number; tokenUsage?: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number }; tools?: AgentToolUse[] };
    detail?: string;
  };
  if (!response.ok || !payload.ok || typeof payload.answer !== "string") {
    throw new Error(payload.detail || `${args.engine} failed (${response.status}).`);
  }
  let proposal: AgentProposal | undefined;
  if (payload.proposal) {
    proposal = coerceProposal(payload.proposal);
  }
  if (!proposal && typeof payload.answer === "string") {
    // Some framework adapters return a JSON object as text. Accept only a
    // schema-valid proposal; all other text remains an Ask-style answer.
    const candidate = payload.answer.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    try {
      proposal = coerceProposal(JSON.parse(candidate));
    } catch {
      // Natural-language answers are intentionally retained as read-only text.
    }
  }
  return { ...payload, proposal };
}
