import { z } from "zod";

import { agentProposalSchema, type AgentProposal } from "./agent-safety.ts";

/** Versioned boundary shared by every agent engine before persistence or approval. */
export const AGENT_CONTRACT_VERSION = 2 as const;

const identifier = z.string().trim().min(1).max(200);

export const workspaceSnapshotSchema = z
  .object({
    repository: identifier,
    path: z.string().trim().max(1_000).optional(),
    branch: z.string().trim().max(300).optional(),
    headSha: z.string().trim().max(128).optional(),
  })
  .strict();

/** Exact tool operations authorized by the same approval payload. Keeping
 * these separate from the model's human-facing proposedAction prevents an
 * `apply & run` flow from accidentally binding a tool name to a prose label. */
export const mutationOperationSchema = z
  .object({
    action: identifier,
    input: z.record(z.string(), z.unknown()),
  })
  .strict();

export const mutationPayloadSchema = z
  .object({
    action: z.string().trim().min(1).max(240),
    workspaceId: identifier,
    taskId: identifier.nullable(),
    snapshot: workspaceSnapshotSchema,
    artifacts: z.array(agentProposalSchema.shape.artifacts.element).max(8),
    execution: agentProposalSchema.shape.execution,
    executions: z.array(agentProposalSchema.shape.execution.unwrap()).max(8),
    operations: z.array(mutationOperationSchema).max(8),
  })
  .strict();

export type AgentMutationPayload = z.infer<typeof mutationPayloadSchema>;

export const approvalBindingSchema = z
  .object({
    required: z.boolean(),
    payload: mutationPayloadSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.required && !value.payload) {
      context.addIssue({ code: "custom", path: ["payload"], message: "required approval must include its complete mutation payload" });
    }
    if (!value.required && value.payload) {
      context.addIssue({ code: "custom", path: ["payload"], message: "non-approved response cannot carry a mutation payload" });
    }
  });

export const agentContractV2Schema = z
  .object({
    contractVersion: z.literal(AGENT_CONTRACT_VERSION),
    runId: identifier,
    framework: identifier,
    model: identifier,
    request: z
      .object({
        mode: z.enum(["agent", "ask"]),
        workspaceId: identifier,
        taskId: identifier.nullable(),
        snapshot: workspaceSnapshotSchema,
      })
      .strict(),
    proposal: agentProposalSchema,
    mutation: mutationPayloadSchema,
    approval: approvalBindingSchema,
  })
  .strict();

export type AgentContractV2 = z.infer<typeof agentContractV2Schema>;

export function buildAgentContractV2(input: {
  runId: string;
  framework: string;
  model: string;
  mode: "agent" | "ask";
  workspaceId: string;
  taskId?: string;
  snapshot: {
    repository: string;
    path?: string;
    branch?: string;
    headSha?: string;
  };
  proposal: AgentProposal;
}): AgentContractV2 {
  const proposal = agentProposalSchema.parse(input.proposal);
  const mutation: AgentMutationPayload = {
    action: proposal.proposedAction,
    workspaceId: input.workspaceId,
    taskId: input.taskId ?? null,
    snapshot: workspaceSnapshotSchema.parse(input.snapshot),
    artifacts: proposal.artifacts,
    execution: proposal.execution,
    executions: proposal.executions ?? [],
    operations: [
      ...(proposal.artifacts.length > 0
        ? [{ action: "fs.write", input: { files: proposal.artifacts.map(({ path, content }) => ({ path, content })) } }]
        : []),
      ...((proposal.executions?.length ?? 0) > 0 || proposal.execution
        ? [{
            action: "terminal.execute-batch",
            input: {
              commands: [
                ...(proposal.execution ? [proposal.execution] : []),
                ...(proposal.executions ?? []),
              ].map((execution) => ({
                command: execution.command?.trim() ||
                  `python "${execution.entrypoint ?? ""}" ${(execution.args ?? []).map((arg) => JSON.stringify(arg)).join(" ")}`.trim(),
                cwd: ".",
                timeoutMs: execution.timeoutMs,
              })),
            },
          }]
        : []),
    ],
  };
  const hasMutation = proposal.artifacts.length > 0 || proposal.execution !== null || (proposal.executions?.length ?? 0) > 0;
  const required = proposal.needsApproval || hasMutation;
  return agentContractV2Schema.parse({
    contractVersion: AGENT_CONTRACT_VERSION,
    runId: input.runId,
    framework: input.framework,
    model: input.model,
    request: {
      mode: input.mode,
      workspaceId: input.workspaceId,
      taskId: input.taskId ?? null,
      snapshot: input.snapshot,
    },
    proposal,
    mutation,
    approval: {
      required,
      payload: required ? mutation : null,
    },
  });
}
