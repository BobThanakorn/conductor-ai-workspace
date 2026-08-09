import { ApiError } from "./api-contract.ts";

export const OPERATIONS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS operations_quota (workspace_id TEXT NOT NULL, bucket TEXT NOT NULL, window_start TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (workspace_id, bucket, window_start))`,
  `CREATE TABLE IF NOT EXISTS operations_audit (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_id TEXT NOT NULL, event_type TEXT NOT NULL, trace_id TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TRIGGER IF NOT EXISTS operations_audit_no_update BEFORE UPDATE ON operations_audit BEGIN SELECT RAISE(ABORT, 'operations_audit is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS operations_audit_no_delete BEFORE DELETE ON operations_audit BEGIN SELECT RAISE(ABORT, 'operations_audit is append-only'); END`,
];

export function traceId(request: Request) {
  const value = request.headers.get("x-conductor-trace-id");
  return value && /^[a-zA-Z0-9_-]{16,96}$/.test(value) ? value : crypto.randomUUID();
}

export async function ensureOperationsSchema(db: D1Database) { for (const statement of OPERATIONS_SCHEMA) await db.prepare(statement).run(); }

export function quotaLimit(value: string | undefined, fallback: number) {
  const parsed = Number(value ?? String(fallback));
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new ApiError(500, "operations_quota_invalid", "The configured quota is invalid.");
  }
  return parsed;
}

export async function reserveQuota(db: D1Database, input: {
  workspaceId: string;
  actorId: string;
  traceId: string;
  bucket: "agent" | "automation";
  limit: number;
  now?: Date;
}) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10_000) throw new ApiError(500, "operations_quota_invalid", "The configured quota is invalid.");
  const now = input.now ?? new Date(); const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
  const result = await db.prepare(`INSERT INTO operations_quota (workspace_id,bucket,window_start,used) VALUES (?,?,?,1) ON CONFLICT(workspace_id,bucket,window_start) DO UPDATE SET used=used+1 WHERE used < ? RETURNING used`).bind(input.workspaceId,input.bucket,windowStart,input.limit).first<{ used: number }>();
  await auditOperation(db, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    traceId: input.traceId,
    type: result ? "operations.quota.reserved" : "operations.quota.denied",
    detail: {
      bucket: input.bucket,
      decision: result ? "allowed" : "denied",
      limit: input.limit,
      used: result?.used ?? input.limit,
      windowStart,
    },
  });
  if (!result) throw new ApiError(429, "operations_quota_exhausted", "Request quota is exhausted. Retry after the current minute window.");
  return { used: result.used, limit: input.limit, windowStart };
}

export async function auditOperation(db: D1Database, input: { workspaceId: string; actorId: string; traceId: string; type: string; detail: Record<string, string | number | boolean> }) {
  await db.prepare("INSERT INTO operations_audit (id,workspace_id,actor_id,event_type,trace_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(),input.workspaceId,input.actorId,input.type,input.traceId,JSON.stringify(input.detail),new Date().toISOString()).run();
}
