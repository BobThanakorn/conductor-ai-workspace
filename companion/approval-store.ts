import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const APPROVAL_TTL_MS = 5 * 60_000;

type PendingApproval = {
  digest: string;
  action: string;
  expiresAt: number;
  tokenHash?: Buffer;
  used: boolean;
};

const approvals = new Map<string, PendingApproval>();

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export function actionDigest(action: string, input: unknown): string {
  return createHash("sha256")
    .update("conductor.local-approval.v1\0")
    .update(canonical({ action, input }))
    .digest("hex");
}

export function requestApproval(action: string, input: unknown) {
  pruneApprovals();
  const id = randomUUID();
  const digest = actionDigest(action, input);
  const expiresAt = Date.now() + APPROVAL_TTL_MS;
  approvals.set(id, { action, digest, expiresAt, used: false });
  return { approvalId: id, action, digest, expiresAt: new Date(expiresAt).toISOString() };
}

export function approveAction(approvalId: string, digest: string) {
  pruneApprovals();
  const record = approvals.get(approvalId);
  if (!record || record.used || record.expiresAt <= Date.now()) {
    throw new Error("Approval request is missing, expired, or already used.");
  }
  if (record.digest !== digest) throw new Error("Approval digest does not match the reviewed action.");
  const token = randomBytes(32).toString("base64url");
  record.tokenHash = createHash("sha256").update(token).digest();
  return { token, expiresAt: new Date(record.expiresAt).toISOString() };
}

export function consumeApproval(token: string | undefined, action: string, input: unknown) {
  pruneApprovals();
  if (!token) throw new Error("A one-time X-Conductor-Approval token is required.");
  const tokenHash = createHash("sha256").update(token).digest();
  const digest = actionDigest(action, input);
  for (const record of approvals.values()) {
    if (
      !record.used &&
      record.expiresAt > Date.now() &&
      record.action === action &&
      record.digest === digest &&
      record.tokenHash &&
      timingSafeEqual(record.tokenHash, tokenHash)
    ) {
      record.used = true;
      return;
    }
  }
  throw new Error("Approval token is invalid, expired, reused, or bound to a different action.");
}

function pruneApprovals() {
  const now = Date.now();
  for (const [id, record] of approvals) {
    if (record.expiresAt <= now || (record.used && record.expiresAt + APPROVAL_TTL_MS <= now)) {
      approvals.delete(id);
    }
  }
}
