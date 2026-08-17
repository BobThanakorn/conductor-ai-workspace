export const dynamic = "force-dynamic";

const allowedRoutes = new Map<string, ReadonlySet<string>>([
  ["health", new Set(["GET"])],
  ["fs/tree", new Set(["GET"])],
  ["git/status", new Set(["GET"])],
  ["workspace/select", new Set(["POST"])],
  ["fs/read", new Set(["POST"])],
  ["context/search", new Set(["POST"])],
  ["skills/catalog", new Set(["GET"])],
  ["skills/resolve", new Set(["POST"])],
  ["fs/write", new Set(["POST"])],
  ["fs/delete", new Set(["POST"])],
  ["terminal/execute", new Set(["POST"])],
  ["terminal/execute-batch", new Set(["POST"])],
  ["git/diff", new Set(["POST"])],
  ["git/commit", new Set(["POST"])],
  ["approvals/request", new Set(["POST"])],
  ["approvals/approve", new Set(["POST"])],
  ["mcp/read", new Set(["POST"])],
]);
const MAX_PROXY_BODY_BYTES = 4_500_000;

export function targetForCompanionPath(path: string[]) {
  const useLangGraphCompanion = path[0] === "langgraph";
  const downstreamPath = (useLangGraphCompanion ? path.slice(1) : path).join("/");
  return {
    downstreamPath,
    origin: useLangGraphCompanion ? "http://companion-langgraph:8765" : "http://companion:8765",
  };
}

export function isAllowedCompanionRoute(method: string, path: string[]) {
  const { downstreamPath } = targetForCompanionPath(path);
  return allowedRoutes.get(downstreamPath)?.has(method) === true;
}

async function boundedRequestBody(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_BODY_BYTES) {
    throw new Error("Companion request body is too large.");
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PROXY_BODY_BYTES) throw new Error("Companion request body is too large.");
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** A bounded, same-origin bridge; never a general proxy or credential forwarder. */
export async function proxyCompanionRequest(request: Request, path: string[]) {
  const { downstreamPath, origin } = targetForCompanionPath(path);
  if (!allowedRoutes.get(downstreamPath)?.has(request.method)) {
    return Response.json({ ok: false, error: "Companion route is not exposed through the web boundary." }, { status: 404 });
  }

  let requestBody: string | undefined;
  if (request.method === "POST") {
    try {
      requestBody = new TextDecoder().decode(await boundedRequestBody(request));
    } catch {
      return Response.json({ ok: false, error: "Companion request body is too large." }, { status: 413 });
    }
  }
  const headers = new Headers();
  if (request.method === "POST") headers.set("Content-Type", "application/json");
  const approval = request.headers.get("x-conductor-approval");
  if (approval) headers.set("X-Conductor-Approval", approval);
  const url = new URL(request.url);
  const upstream = await fetch(`${origin}/${downstreamPath}${url.search}`, {
    method: request.method,
    headers,
    body: requestBody,
    cache: "no-store",
  });
  const responseBody = await upstream.text();
  return new Response(responseBody, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function proxy(request: Request, params: Promise<{ path: string[] }>) {
  const { path } = await params;
  return proxyCompanionRequest(request, path);
}

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, context.params);
}

export async function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxy(request, context.params);
}
