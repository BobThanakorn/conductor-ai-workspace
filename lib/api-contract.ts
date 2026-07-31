import { z, type ZodError } from "zod";

import { pythonWorkspaceFilesSchema } from "@/lib/agent-safety";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "must use letters, numbers, dots, colons, underscores, or hyphens",
  );

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "must use letters, numbers, dots, colons, underscores, or hyphens",
  );

const noteSchema = z.string().trim().max(500).optional();

const commonActionFields = {
  idempotencyKey: idempotencyKeySchema.optional(),
  workspaceId: identifierSchema.optional(),
};

export const workspaceActionSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...commonActionFields,
      action: z.literal("create_task"),
      title: z.string().trim().min(3).max(120),
      goal: z.string().trim().min(3).max(2_000),
      riskLevel: z.enum(["R0", "R1", "R2", "R3"]).default("R1"),
      branch: z
        .string()
        .trim()
        .min(1)
        .max(180)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      ...commonActionFields,
      action: z.literal("approve"),
      approvalId: identifierSchema,
      note: noteSchema,
      actor: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
  z
    .object({
      ...commonActionFields,
      action: z.literal("reject"),
      approvalId: identifierSchema,
      note: noteSchema,
      actor: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
  z
    .object({
      ...commonActionFields,
      action: z.literal("cancel"),
      taskId: identifierSchema,
      reason: z.string().trim().max(500).optional(),
      actor: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
  z
    .object({
      ...commonActionFields,
      action: z.literal("resume"),
      taskId: identifierSchema,
      note: noteSchema,
      actor: z.string().trim().min(1).max(80).optional(),
    })
    .strict(),
]);

export type WorkspaceAction = z.infer<typeof workspaceActionSchema>;

export const agentRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(6_000),
    mode: z.enum(["agent", "ask"]).default("agent"),
    engine: z.enum(["openai-agents", "langgraph"]).default("openai-agents"),
    model: z.string().trim().min(1).max(200).optional(),
    taskId: identifierSchema.optional(),
    workspaceId: identifierSchema.optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
    workspaceFiles: pythonWorkspaceFilesSchema.optional(),
    workspace: z
      .object({
        repository: z.string().trim().min(1).max(300),
        path: z.string().trim().max(1_000).optional(),
        branch: z.string().trim().max(300).optional(),
        headSha: z.string().trim().max(128).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AgentRequest = z.infer<typeof agentRequestSchema>;

export async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(
      415,
      "unsupported_media_type",
      "Content-Type must be application/json.",
    );
  }

  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ApiError(
        400,
        "invalid_json_body",
        "The JSON body must be an object.",
      );
    }
    return value;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
}

export function validationError(error: ZodError): ApiError {
  return new ApiError(400, "validation_error", "Request validation failed.", {
    issues: error.issues.slice(0, 12).map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

export function requireIdempotencyKey(
  request: Request,
  bodyKey?: string,
): string {
  const headerKey = request.headers.get("idempotency-key")?.trim();
  if (headerKey && bodyKey && headerKey !== bodyKey) {
    throw new ApiError(
      400,
      "idempotency_key_mismatch",
      "The Idempotency-Key header and body idempotencyKey must match.",
    );
  }

  const parsed = idempotencyKeySchema.safeParse(headerKey ?? bodyKey);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "idempotency_key_required",
      "Provide an Idempotency-Key header or idempotencyKey body field (8-128 safe characters).",
    );
  }
  return parsed.data;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      error.status,
    );
  }

  return jsonResponse(
    {
      ok: false,
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
      },
    },
    500,
  );
}
