import { z } from "zod";

const mcpIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const mcpServerStatusSchema = z.enum([
  "registered",
  "connected",
  "disconnected",
  "unavailable",
  "revoked",
]);
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

export const mcpToolRiskSchema = z.enum(["read", "write", "execute", "external"]);
export type McpToolRisk = z.infer<typeof mcpToolRiskSchema>;

export const mcpPolicyDecisionSchema = z.enum(["allow", "deny", "inherit"]);
export type McpPolicyDecision = z.infer<typeof mcpPolicyDecisionSchema>;

export const mcpPolicyScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workspace") }).strict(),
  z
    .object({
      type: z.literal("agent"),
      agentId: mcpIdentifierSchema,
    })
    .strict(),
]);
export type McpPolicyScope = z.infer<typeof mcpPolicyScopeSchema>;

export const mcpPolicyMutationSchema = z
  .object({
    workspaceId: mcpIdentifierSchema.optional(),
    expectedRevision: z.number().int().min(0),
    scope: mcpPolicyScopeSchema,
    serverId: mcpIdentifierSchema,
    toolName: z.string().trim().min(1).max(240),
    decision: mcpPolicyDecisionSchema,
  })
  .strict();
export type McpPolicyMutation = z.infer<typeof mcpPolicyMutationSchema>;

export const mcpToolDescriptorSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    title: z.string().trim().max(240).optional(),
    description: z.string().trim().max(1_000).optional(),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    risk: mcpToolRiskSchema,
    requiresApproval: z.boolean(),
    serverId: mcpIdentifierSchema,
    provenance: z
      .object({
        source: z.literal("mcp"),
        serverId: mcpIdentifierSchema,
        transport: z.literal("streamable-http"),
      })
      .strict(),
  })
  .strict();
export type McpToolDescriptor = z.infer<typeof mcpToolDescriptorSchema>;

export const mcpServerActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("register"),
      workspaceId: mcpIdentifierSchema.optional(),
      allowlistId: mcpIdentifierSchema,
    })
    .strict(),
  ...(["connect", "disconnect", "refresh", "check_health", "revoke"] as const).map(
    (action) =>
      z
        .object({
          action: z.literal(action),
          workspaceId: mcpIdentifierSchema.optional(),
          serverId: mcpIdentifierSchema,
        })
        .strict(),
  ),
]);
export type McpServerAction = z.infer<typeof mcpServerActionSchema>;

export type McpAllowlistEntry = {
  id: string;
  label: string;
  url: string;
  transport: "streamable-http";
  secretRef?: string;
};

export type McpRegistryServer = {
  workspaceId: string;
  serverId: string;
  allowlistId: string;
  label: string;
  status: McpServerStatus;
  enabled: boolean;
  capabilities: Record<string, unknown>;
  tools: McpToolDescriptor[];
  revision: number;
  lastErrorCode?: string;
  lastCheckedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type McpRuntimeServer = {
  id: string;
  label: string;
  url: string;
  transport: "streamable-http";
  authorization?: string;
  revision: number;
  policyRevision: number;
  credentialFingerprint?: string;
  tools: Array<McpToolDescriptor & {
    serverRevision: number;
    policyRevision: number;
  }>;
};
