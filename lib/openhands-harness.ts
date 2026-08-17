import { agentProposalSchema, redactSensitiveText, type AgentProposal } from "./agent-safety.ts";
import type { AgentRuntimeConfig } from "./agent-provider.ts";

export class OpenHandsHarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenHandsHarnessError";
  }
}

type OpenHandsWorkspace = {
  repository: string;
  path?: string;
  branch?: string;
  headSha?: string;
};

function requireTaskWorktree(taskId: string | undefined, workspace: OpenHandsWorkspace | undefined) {
  if (!taskId) throw new OpenHandsHarnessError("OpenHands requires a task-bound worktree.");
  if (!workspace?.repository || !workspace.path) {
    throw new OpenHandsHarnessError("OpenHands requires an explicit task worktree path.");
  }
  if (/^(?:[A-Za-z]:|[\\/])/.test(workspace.path) || workspace.path.includes("..")) {
    throw new OpenHandsHarnessError("OpenHands worktree path must be repository-relative.");
  }
}

function parseStrictProposal(value: unknown): AgentProposal {
  let candidate = value;
  if (typeof candidate === "string") {
    const text = candidate.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    try {
      candidate = JSON.parse(text);
    } catch {
      throw new OpenHandsHarnessError("OpenHands returned malformed structured output.");
    }
  }
  const parsed = agentProposalSchema.safeParse(candidate);
  if (!parsed.success) throw new OpenHandsHarnessError("OpenHands returned an invalid Contract v2 proposal.");
  return parsed.data;
}

export async function getOpenHandsHealth(serviceUrl: string) {
  const response = await fetch(`${serviceUrl.replace(/\/$/, "")}/health`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) return { ok: false, ready: false };
  const payload = await response.json() as { ok?: boolean; ready?: boolean; engine?: string; version?: string };
  return { ...payload, ok: payload.ok === true, ready: payload.ready === true };
}

export async function runOpenHandsHarness(args: {
  serviceUrl: string;
  runtime: AgentRuntimeConfig;
  message: string;
  mode: "agent" | "ask";
  taskId?: string;
  workspace?: OpenHandsWorkspace;
  workspaceFiles: Array<{ path: string; content: string }>;
}) {
  requireTaskWorktree(args.taskId, args.workspace);
  const baseUrl = args.serviceUrl.replace(/\/$/, "");
  const prompt = [
    "Return exactly one JSON object matching the Conductor Agent Contract v2 proposal schema.",
    "Never execute commands or mutate files. Produce bounded artifacts and executions only as a proposal.",
    "All paths must remain inside the supplied task worktree. Malformed output is rejected.",
    `Task worktree boundary: ${JSON.stringify(args.workspace)}`,
    redactSensitiveText(args.message),
  ].join("\n");
  const response = await fetch(`${baseUrl}/api/v1/app-conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `Conductor OpenHands task ${args.taskId}`,
      llm_model: args.runtime.model,
      initial_message: { role: "user", run: true, content: [{ type: "text", text: prompt }] },
      conductor: {
        contractVersion: 2,
        mode: args.mode,
        taskId: args.taskId,
        workspace: args.workspace,
        workspaceFiles: args.workspaceFiles.map((file) => ({ ...file, content: redactSensitiveText(file.content) })),
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const start = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new OpenHandsHarnessError(`OpenHands start failed (${response.status}).`);
  const conversationId = start.app_conversation_id ?? start.conversation_id;
  if (typeof conversationId !== "string" || !conversationId) {
    throw new OpenHandsHarnessError("OpenHands did not return a conversation id.");
  }
  const eventsResponse = await fetch(`${baseUrl}/api/v1/conversation/${encodeURIComponent(conversationId)}/events/search?limit=20`, {
    signal: AbortSignal.timeout(120_000),
  });
  const events = await eventsResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!eventsResponse.ok) throw new OpenHandsHarnessError("OpenHands event retrieval failed.");
  const items = Array.isArray(events.items) ? events.items : Array.isArray(events.events) ? events.events : [];
  const raw = items.at(-1);
  const proposalValue = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? ((raw as Record<string, unknown>).proposal ?? (raw as Record<string, unknown>).content ?? (raw as Record<string, unknown>).message)
    : raw;
  const proposal = parseStrictProposal(proposalValue);
  return { proposal, conversationId, eventCount: items.length, ready: true };
}
