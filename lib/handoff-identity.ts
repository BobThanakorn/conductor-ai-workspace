import { ApiError } from "./api-contract.ts";

export type HandoffPrincipal = {
  actorId: string;
  displayName?: string;
  role: "planner" | "implementer" | "tester" | "reviewer";
  kind: "worker" | "human";
  audience: "conductor-handoff-api";
  workspaceId: string;
  taskId?: string;
  expiresAt: number;
};

type IdentityPayload = HandoffPrincipal & { version: 1 };

const identityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export function canonicalActorId(value: string): string {
  const actorId = value.trim().normalize("NFKC").toLowerCase();
  if (!identityIdPattern.test(actorId)) throw new Error("A canonical handoff actor ID is required.");
  return actorId;
}

function scopedId(value: string, label: string): string {
  const result = value.trim();
  if (!identityIdPattern.test(result)) throw new Error(`A valid handoff ${label} is required.`);
  return result;
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encode(value: string): string {
  return encodeBytes(new TextEncoder().encode(value));
}

function decode(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

async function signature(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const value = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return encodeBytes(new Uint8Array(value));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function createHandoffIdentityToken(input: {
  actorId: string;
  displayName?: string;
  role: HandoffPrincipal["role"];
  kind: HandoffPrincipal["kind"];
  workspaceId: string;
  taskId?: string;
  secret: string;
  ttlSeconds?: number;
}): Promise<string> {
  if (!input.secret.trim()) throw new Error("A handoff signing secret is required.");
  const payload: IdentityPayload = {
    version: 1,
    actorId: canonicalActorId(input.actorId),
    ...(input.displayName?.trim() ? { displayName: input.displayName.trim().slice(0, 128) } : {}),
    role: input.role,
    kind: input.kind,
    audience: "conductor-handoff-api",
    workspaceId: scopedId(input.workspaceId, "workspace ID"),
    ...(input.taskId ? { taskId: scopedId(input.taskId, "task ID") } : {}),
    expiresAt: Math.floor(Date.now() / 1000) + Math.min(Math.max(input.ttlSeconds ?? 300, 30), 900),
  };
  const encoded = encode(JSON.stringify(payload));
  return `v1.${encoded}.${await signature(encoded, input.secret)}`;
}

export async function authenticateHandoffIdentity(
  request: Request,
  secret: string | undefined,
  scope?: { workspaceId: string; taskId?: string },
): Promise<HandoffPrincipal> {
  const token = request.headers.get("x-conductor-identity")?.trim() ||
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!secret?.trim()) throw new ApiError(503, "handoff_identity_not_configured", "The handoff signing secret is not configured on the server.");
  if (!token) throw new ApiError(401, "handoff_identity_required", "A signed handoff identity token is required.");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new ApiError(401, "handoff_identity_invalid", "The handoff identity token is invalid.");
  const expected = await signature(parts[1], secret);
  if (!constantTimeEqual(expected, parts[2])) throw new ApiError(401, "handoff_identity_invalid", "The handoff identity signature is invalid.");
  let payload: unknown;
  try { payload = JSON.parse(decode(parts[1])); } catch { throw new ApiError(401, "handoff_identity_invalid", "The handoff identity payload is invalid."); }
  const value = payload as Partial<IdentityPayload>;
  if (value.version !== 1 || value.audience !== "conductor-handoff-api" || typeof value.actorId !== "string" || typeof value.workspaceId !== "string" || !["planner", "implementer", "tester", "reviewer"].includes(value.role ?? "") || !["worker", "human"].includes(value.kind ?? "") || typeof value.expiresAt !== "number" || value.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new ApiError(401, "handoff_identity_expired", "The handoff identity token is expired or malformed.");
  }
  let actorId: string;
  let workspaceId: string;
  let taskId: string | undefined;
  try {
    actorId = canonicalActorId(value.actorId);
    workspaceId = scopedId(value.workspaceId, "workspace ID");
    taskId = value.taskId === undefined ? undefined : scopedId(value.taskId, "task ID");
  } catch {
    throw new ApiError(401, "handoff_identity_invalid", "The handoff identity scope is invalid.");
  }
  if (scope && (workspaceId !== scope.workspaceId || (taskId && scope.taskId && taskId !== scope.taskId))) {
    throw new ApiError(403, "handoff_identity_scope_forbidden", "The signed handoff identity does not cover this workspace or task.");
  }
  return {
    actorId,
    ...(typeof value.displayName === "string" && value.displayName.trim() ? { displayName: value.displayName.trim().slice(0, 128) } : {}),
    role: value.role as HandoffPrincipal["role"],
    kind: value.kind as HandoffPrincipal["kind"],
    audience: "conductor-handoff-api",
    workspaceId,
    ...(taskId ? { taskId } : {}),
    expiresAt: value.expiresAt,
  };
}
