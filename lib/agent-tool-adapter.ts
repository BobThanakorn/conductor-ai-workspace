import { z } from "zod";

export const companionToolIdSchema = z.enum([
  "fs.tree",
  "fs.read",
  "fs.write",
  "fs.delete",
  "terminal.execute",
  "terminal.execute-batch",
  "git.status",
  "git.diff",
  "git.commit",
  "mcp.read",
]);

export type CompanionToolId = z.infer<typeof companionToolIdSchema>;

type ToolDefinition = {
  id: CompanionToolId;
  action: string;
  endpoint: string;
  method: "GET" | "POST";
  requiresApproval: boolean;
};

const TOOL_DEFINITIONS: Record<CompanionToolId, ToolDefinition> = {
  "fs.tree": { id: "fs.tree", action: "fs.tree", endpoint: "/fs/tree", method: "GET", requiresApproval: false },
  "fs.read": { id: "fs.read", action: "fs.read", endpoint: "/fs/read", method: "POST", requiresApproval: false },
  "fs.write": { id: "fs.write", action: "fs.write", endpoint: "/fs/write", method: "POST", requiresApproval: true },
  "fs.delete": { id: "fs.delete", action: "fs.delete", endpoint: "/fs/delete", method: "POST", requiresApproval: true },
  "terminal.execute": { id: "terminal.execute", action: "terminal.execute", endpoint: "/terminal/execute", method: "POST", requiresApproval: true },
  "terminal.execute-batch": { id: "terminal.execute-batch", action: "terminal.execute-batch", endpoint: "/terminal/execute-batch", method: "POST", requiresApproval: true },
  "git.status": { id: "git.status", action: "git.read", endpoint: "/git/status", method: "GET", requiresApproval: false },
  "git.diff": { id: "git.diff", action: "git.read", endpoint: "/git/diff", method: "GET", requiresApproval: false },
  "git.commit": { id: "git.commit", action: "git.commit", endpoint: "/git/commit", method: "POST", requiresApproval: true },
  "mcp.read": { id: "mcp.read", action: "mcp.read", endpoint: "/mcp/read", method: "POST", requiresApproval: false },
};

export function getCompanionToolDefinition(id: CompanionToolId): ToolDefinition {
  return TOOL_DEFINITIONS[id];
}

export function bindContractMutation(input: Record<string, unknown>, mutation?: unknown): Record<string, unknown> {
  return mutation ? { ...input, contractVersion: 2, contractMutation: mutation } : input;
}

export async function invokeCompanionTool<T>(args: {
  baseUrl: string;
  tool: CompanionToolId;
  input?: Record<string, unknown>;
  contractMutation?: unknown;
}): Promise<T> {
  const definition = getCompanionToolDefinition(args.tool);
  const input = bindContractMutation(args.input ?? {}, args.contractMutation);
  const request = definition.method === "GET"
    ? await fetch(`${args.baseUrl}${definition.endpoint}`)
    : await fetch(`${args.baseUrl}${definition.endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
  const payload = await request.json() as { ok?: boolean; error?: string | { message?: string } } & T;
  if (!request.ok || payload.ok === false) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(message || `Companion tool ${args.tool} failed (${request.status}).`);
  }
  return payload;
}

/** Read-only MCP calls use the same bounded transport boundary as companion tools. */
export async function invokeReadOnlyMcpTool<T>(args: {
  gatewayUrl: string;
  name: string;
  arguments?: Record<string, unknown>;
  transport: (url: string, body: Record<string, unknown>) => Promise<T>;
}): Promise<T> {
  if (!/^https:\/\//i.test(args.gatewayUrl) && !/^http:\/\/(?:mcp-gateway|localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(args.gatewayUrl)) {
    throw new Error("MCP gateway must use HTTPS or a trusted local Compose hostname.");
  }
  if (!/^(?:get|list|read|search|fetch|inspect|view|query)_?/i.test(args.name)) {
    throw new Error("Only read-only MCP tools are allowed through the shared adapter.");
  }
  return args.transport(args.gatewayUrl, {
    jsonrpc: "2.0",
    id: `mcp_${Date.now()}`,
    method: "tools/call",
    params: { name: args.name, arguments: args.arguments ?? {} },
  });
}

export async function invokeApprovedCompanionTool<T>(args: {
  baseUrl: string;
  tool: CompanionToolId;
  input?: Record<string, unknown>;
  contractMutation?: unknown;
}): Promise<T> {
  const definition = getCompanionToolDefinition(args.tool);
  if (!definition.requiresApproval) return invokeCompanionTool<T>(args);
  const input = bindContractMutation(args.input ?? {}, args.contractMutation);
  const requestResponse = await fetch(`${args.baseUrl}/approvals/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: definition.action, input }),
  });
  const approval = await requestResponse.json() as { approvalId?: string; digest?: string; error?: string | { message?: string } };
  if (!requestResponse.ok || !approval.approvalId || !approval.digest) throw new Error(typeof approval.error === "string" ? approval.error : "Companion approval request failed.");
  const approveResponse = await fetch(`${args.baseUrl}/approvals/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true, approvalId: approval.approvalId, digest: approval.digest }),
  });
  const approved = await approveResponse.json() as { token?: string; error?: string | { message?: string } };
  if (!approveResponse.ok || !approved.token) throw new Error(typeof approved.error === "string" ? approved.error : "Companion approval was not issued.");
  const response = await fetch(`${args.baseUrl}${definition.endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Conductor-Approval": approved.token },
    body: JSON.stringify(input),
  });
  const payload = await response.json() as { ok?: boolean; error?: string | { message?: string } } & T;
  if (!response.ok || payload.ok === false) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(message || `Companion tool ${args.tool} failed (${response.status}).`);
  }
  return payload;
}
