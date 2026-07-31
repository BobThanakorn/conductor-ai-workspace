import type { AgentRuntimeConfig } from "@/lib/agent-provider";
import type { AgentProposal } from "@/lib/agent-safety";
import type { AgentContext } from "@/lib/environment-store";

type LangGraphInput = {
  message: string;
  mode: "agent" | "ask";
  model: string;
  workspaceId: string;
  taskId?: string;
  runId: string;
  workspaceFiles: Array<{ path: string; content: string }>;
  workspace: {
    repository: string;
    path?: string;
    branch?: string;
    headSha?: string;
  };
};

type LangGraphResponse = {
  ok?: boolean;
  engine?: string;
  model?: string;
  threadId?: string;
  checkpointId?: string;
  status?: string;
  output?: AgentProposal;
  metrics?: { durationMs?: number };
  detail?: string;
};

export type LangGraphAgentResult = {
  output: AgentProposal;
  engine: "langgraph";
  threadId: string;
  checkpointId: string;
  status: string;
  metrics: { durationMs?: number };
};

export async function runLangGraphAgent(args: {
  serviceUrl: string;
  serviceToken?: string;
  runtime: AgentRuntimeConfig;
  input: LangGraphInput;
  context: AgentContext;
}): Promise<LangGraphAgentResult> {
  const response = await fetch(`${args.serviceUrl.replace(/\/$/, "")}/v1/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(args.serviceToken
        ? { Authorization: `Bearer ${args.serviceToken}` }
        : {}),
    },
    body: JSON.stringify({
      ...args.input,
      model: args.runtime.model,
      task: args.context.task
        ? {
            id: args.context.task.id,
            title: args.context.task.title,
            goal: args.context.task.goal,
            status: args.context.task.status,
          }
        : null,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json() as LangGraphResponse;
  if (!response.ok || !payload.output) {
    throw new Error(payload.detail || `LangGraph service failed (${response.status}).`);
  }
  return {
    output: payload.output,
    engine: "langgraph",
    threadId: payload.threadId ?? "",
    checkpointId: payload.checkpointId ?? "",
    status: payload.status ?? "completed",
    metrics: payload.metrics ?? {},
  };
}

export async function getLangGraphHealth(
  serviceUrl: string,
): Promise<{ ok: boolean; engine?: string; checkpoint?: string; modelConfigured?: boolean }> {
  const response = await fetch(`${serviceUrl.replace(/\/$/, "")}/health`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) return { ok: false };
  return response.json() as Promise<{
    ok: boolean;
    engine?: string;
    checkpoint?: string;
    modelConfigured?: boolean;
  }>;
}
