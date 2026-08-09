import { z } from "zod";

/**
 * Durable handoffs are the boundary between agent roles.  The envelope is
 * deliberately small and immutable: a reviewer receives exactly the context
 * and evidence that the submitting worker produced, not a live mutable view
 * of the repository.
 */
export const HANDOFF_VERSION = 1 as const;
export const HANDOFF_MAX_FILES = 8;
export const HANDOFF_MAX_FILE_BYTES = 16_000;
export const HANDOFF_MAX_CONTEXT_BYTES = 48_000;
export const HANDOFF_MAX_CONTEXT_TOKENS = 12_000;

export const handoffRoleSchema = z.enum([
  "planner",
  "implementer",
  "tester",
  "reviewer",
]);
export type HandoffRole = z.infer<typeof handoffRoleSchema>;

export const handoffStatusSchema = z.enum([
  "pending",
  "accepted",
  "approved",
  "rejected",
  "conflict",
  "published",
]);
export type HandoffStatus = z.infer<typeof handoffStatusSchema>;

const relativePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .transform((value) => value.replaceAll("\\", "/"))
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:\//.test(value), "context paths must be relative")
  .refine((value) => !value.split("/").includes(".."), "context paths cannot traverse parent directories")
  .refine(
    (value) => !/(^|\/)(?:\.env(?:\.|$)|credentials(?:\.|$)|secrets?(?:\.|$)|id_(?:rsa|ed25519)|\.npmrc$|\.pypirc$|\.netrc$|.*\.(?:pem|key|p12|pfx)$)/i.test(value),
    "secret files cannot enter a handoff context",
  );

function containsLikelySecret(content: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content) ||
    /\b(?:github_pat_|gh[opsu]_|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})[A-Za-z0-9_-]*/.test(content) ||
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i.test(content);
}

export const handoffContextFileSchema = z
  .object({
    path: relativePathSchema,
    content: z.string().max(HANDOFF_MAX_FILE_BYTES),
    snapshotId: z.string().trim().min(1).max(128),
  })
  .strict()
  .superRefine((value, context) => {
    if (containsLikelySecret(value.content)) {
      context.addIssue({ code: "custom", path: ["content"], message: "likely credentials cannot enter a handoff context" });
    }
  });

export const handoffContextSchema = z
  .object({
    snapshotId: z.string().trim().min(1).max(128),
    files: z.array(handoffContextFileSchema).max(HANDOFF_MAX_FILES),
    totalTokens: z.number().int().nonnegative().max(HANDOFF_MAX_CONTEXT_TOKENS),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = value.files.reduce((total, file) => total + new TextEncoder().encode(file.content).byteLength, 0);
    const tokens = value.files.reduce((total, file) => total + Math.ceil(file.content.length / 4), 0);
    if (bytes > HANDOFF_MAX_CONTEXT_BYTES) {
      context.addIssue({ code: "custom", path: ["files"], message: "handoff context exceeds the byte budget" });
    }
    if (tokens > HANDOFF_MAX_CONTEXT_TOKENS || value.totalTokens !== tokens) {
      context.addIssue({ code: "custom", path: ["totalTokens"], message: "totalTokens must equal the bounded context estimate" });
    }
    const seen = new Set<string>();
    for (const [index, file] of value.files.entries()) {
      if (seen.has(file.path)) context.addIssue({ code: "custom", path: ["files", index, "path"], message: "context paths must be unique" });
      seen.add(file.path);
      if (file.snapshotId !== value.snapshotId) {
        context.addIssue({ code: "custom", path: ["files", index, "snapshotId"], message: "every context file must use the envelope snapshot" });
      }
    }
  });

export const handoffEvidenceSchema = z
  .object({
    summary: z.string().trim().min(1).max(2_000),
    files: z.array(z.object({ path: relativePathSchema, change: z.string().trim().max(500) }).strict()).max(100),
    checks: z.array(z.object({
      command: z.string().trim().min(1).max(500),
      exitCode: z.number().int(),
      stdout: z.string().max(4_000).optional(),
      stderr: z.string().max(4_000).optional(),
    }).strict()).max(32),
  })
  .strict();
export type HandoffEvidence = z.infer<typeof handoffEvidenceSchema>;

export const handoffEnvelopeSchema = z.object({
  version: z.literal(HANDOFF_VERSION),
  id: z.string().trim().min(1).max(160),
  workspaceId: z.string().trim().min(1).max(128),
  taskId: z.string().trim().min(1).max(128),
  fromRole: handoffRoleSchema,
  toRole: handoffRoleSchema,
  submittedBy: z.string().trim().min(1).max(128),
  context: handoffContextSchema,
  evidence: handoffEvidenceSchema,
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: handoffStatusSchema,
  createdAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  if (!isAllowedTransition(value.fromRole, value.toRole)) {
    context.addIssue({ code: "custom", path: ["toRole"], message: `invalid role transition ${value.fromRole} -> ${value.toRole}` });
  }
});
export type HandoffEnvelope = z.infer<typeof handoffEnvelopeSchema>;

export const handoffActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"), workspaceId: z.string().trim().min(1).max(128), taskId: z.string().trim().min(1).max(128),
    fromRole: handoffRoleSchema, toRole: handoffRoleSchema,
    context: handoffContextSchema, evidence: handoffEvidenceSchema, idempotencyKey: z.string().trim().min(8).max(128).optional(),
  }).strict(),
  z.object({
    action: z.literal("accept"), workspaceId: z.string().trim().min(1).max(128), handoffId: z.string().trim().min(1).max(160),
    idempotencyKey: z.string().trim().min(8).max(128).optional(),
  }).strict(),
  z.object({
    action: z.literal("review"), workspaceId: z.string().trim().min(1).max(128), handoffId: z.string().trim().min(1).max(160),
    decision: z.enum(["approve", "reject"]), evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    notes: z.string().trim().max(2_000).optional(), idempotencyKey: z.string().trim().min(8).max(128).optional(),
  }).strict(),
  z.object({
    action: z.literal("resolve"), workspaceId: z.string().trim().min(1).max(128), handoffId: z.string().trim().min(1).max(160),
    resolution: z.enum(["retry", "discard"]),
    idempotencyKey: z.string().trim().min(8).max(128).optional(),
  }).strict(),
  z.object({
    action: z.literal("publish"), workspaceId: z.string().trim().min(1).max(128), handoffId: z.string().trim().min(1).max(160),
    idempotencyKey: z.string().trim().min(8).max(128).optional(),
  }).strict(),
]).superRefine((value, context) => {
  if (value.action === "create" && !isAllowedTransition(value.fromRole, value.toRole)) {
    context.addIssue({ code: "custom", path: ["toRole"], message: `invalid role transition ${value.fromRole} -> ${value.toRole}` });
  }
});
export type HandoffAction = z.infer<typeof handoffActionSchema>;

export function isAllowedTransition(fromRole: HandoffRole, toRole: HandoffRole): boolean {
  return (fromRole === "planner" && toRole === "implementer") ||
    (fromRole === "implementer" && toRole === "tester") ||
    (fromRole === "tester" && toRole === "reviewer");
}

export function assertIndependentReviewer(submittedBy: string, reviewerId: string): void {
  const canonical = (value: string) => value.trim().normalize("NFKC").toLowerCase();
  if (canonical(submittedBy) === canonical(reviewerId)) {
    throw new Error("Independent review required: the submitting worker cannot approve its own handoff.");
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function evidenceDigest(evidence: HandoffEvidence): Promise<string> {
  return sha256(stableStringify(handoffEvidenceSchema.parse(evidence)));
}

export async function buildHandoffEnvelope(input: {
  id: string;
  workspaceId: string;
  taskId: string;
  fromRole: HandoffRole;
  toRole: HandoffRole;
  submittedBy: string;
  context: z.input<typeof handoffContextSchema>;
  evidence: HandoffEvidence;
  createdAt?: string;
}): Promise<HandoffEnvelope> {
  if (!isAllowedTransition(input.fromRole, input.toRole)) throw new Error(`invalid role transition ${input.fromRole} -> ${input.toRole}`);
  const context = handoffContextSchema.parse(input.context);
  const evidence = handoffEvidenceSchema.parse(input.evidence);
  return handoffEnvelopeSchema.parse({
    version: HANDOFF_VERSION,
    id: input.id,
    workspaceId: input.workspaceId,
    taskId: input.taskId,
    fromRole: input.fromRole,
    toRole: input.toRole,
    submittedBy: input.submittedBy,
    context,
    evidence,
    evidenceDigest: await evidenceDigest(evidence),
    status: "pending",
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
}

export async function assertEvidenceUnchanged(envelope: HandoffEnvelope, evidence: HandoffEvidence): Promise<void> {
  const actual = await evidenceDigest(evidence);
  if (actual !== envelope.evidenceDigest) throw new Error("Submitted evidence no longer matches the immutable handoff digest.");
}
