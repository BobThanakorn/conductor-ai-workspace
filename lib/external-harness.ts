import type { AgentRuntimeConfig } from "@/lib/agent-provider";
import type { AgentToolUse } from "@/lib/agent-telemetry";

export type ExternalHarnessId =
  | "pydantic-ai"
  | "microsoft-agent-framework"
  | "crewai"
  | "llamaindex"
  | "haystack"
  | "semantic-kernel";

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
  workspaceFiles: Array<{ path: string; content: string }>;
}) {
  const response = await fetch(`${args.serviceUrl.replace(/\/$/, "")}/v1/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: args.message,
      model: args.runtime.model,
      workspace_files: args.workspaceFiles,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json() as {
    ok?: boolean;
    answer?: string;
    metrics?: { durationMs?: number; tokenUsage?: { requests: number; inputTokens: number; outputTokens: number; totalTokens: number }; tools?: AgentToolUse[] };
    detail?: string;
  };
  if (!response.ok || !payload.ok || typeof payload.answer !== "string") {
    throw new Error(payload.detail || `${args.engine} failed (${response.status}).`);
  }
  return payload;
}
