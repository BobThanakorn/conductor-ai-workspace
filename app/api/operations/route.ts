import { getDatabase } from "@/lib/environment-store";
import { authenticateServerPrincipal } from "@/lib/server-principal";
import { auditOperation, ensureOperationsSchema, traceId } from "@/lib/operations";
import { errorResponse } from "@/lib/api-contract";

export async function GET(request: Request) {
  const trace = traceId(request);
  try { const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "workspace_local";
    const principal = await authenticateServerPrincipal(request, process.env.CONDUCTOR_HANDOFF_SIGNING_SECRET, { workspaceId }); const db = getDatabase(); await ensureOperationsSchema(db);
    const rows = await db.prepare("SELECT bucket, SUM(used) AS used FROM operations_quota WHERE workspace_id=? AND window_start >= ? GROUP BY bucket").bind(workspaceId,new Date(Date.now()-60_000).toISOString()).all<{bucket:string;used:number}>();
    await auditOperation(db,{workspaceId,actorId:principal.actorId,traceId:trace,type:"operations.metrics.read",detail:{buckets:rows.results.length}});
    return Response.json({ok:true,traceId:trace,liveness:"live",readiness:"ready",metrics:Object.fromEntries(rows.results.map((row)=>[row.bucket,row.used]))},{headers:{"x-conductor-trace-id":trace,"cache-control":"no-store"}});
  } catch (error) { const response = errorResponse(error); response.headers.set("x-conductor-trace-id", trace); return response; }
}
