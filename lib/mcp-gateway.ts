import { classifyAgentToolRisk } from "./agent-tools.ts";
import {
  mcpToolDescriptorSchema,
  type McpAllowlistEntry,
  type McpToolDescriptor,
} from "./mcp-contract.ts";

export class McpGatewayError extends Error {
  readonly code: "mcp_gateway_unavailable" | "mcp_protocol_error";

  constructor(code: McpGatewayError["code"], message: string) {
    super(message);
    this.name = "McpGatewayError";
    this.code = code;
  }
}

export function normalizeTrustedMcpUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const trustedLocal =
    url.protocol === "http:" &&
    ["mcp-gateway", "localhost", "127.0.0.1"].includes(hostname);
  const octets = hostname.split(".").map(Number);
  const literalPrivateOrSpecialIpv4 = octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    (octets[0] === 0 ||
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168) ||
      octets[0] >= 224);
  const forbiddenHost = !trustedLocal &&
    (literalPrivateOrSpecialIpv4 || hostname.includes(":") || hostname.endsWith(".local"));
  if (
    (!trustedLocal && url.protocol !== "https:") ||
    forbiddenHost ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "MCP servers must use HTTPS or the trusted local Docker MCP gateway hostname.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function parseRpcPayload(contentType: string, body: string): Record<string, unknown> {
  try {
    if (contentType.includes("text/event-stream")) {
      const data = body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .find((line) => line && line !== "[DONE]");
      if (!data) throw new Error("missing SSE data");
      return JSON.parse(data) as Record<string, unknown>;
    }
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new McpGatewayError("mcp_protocol_error", "The MCP server returned an invalid protocol response.");
  }
}

const GENERIC_SECRET_PATTERN = /(?:\bsk-[A-Za-z0-9_-]{12,}\b|\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b|-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,})/gi;

function sanitizeMcpString(value: string, secrets: readonly string[]): string {
  let sanitized = value.replace(/\u0000/g, " ");
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.replaceAll(secret, "[redacted-secret]");
  }
  return sanitized.replace(GENERIC_SECRET_PATTERN, "[redacted-secret]");
}

function sanitizeMcpMetadata(
  value: unknown,
  secrets: readonly string[],
  depth = 0,
): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return sanitizeMcpString(value, secrets).slice(0, 4_000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 128).map((item) => sanitizeMcpMetadata(item, secrets, depth + 1));
  }
  if (!value || typeof value !== "object") return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 128)) {
    const key = sanitizeMcpString(rawKey, secrets).slice(0, 240);
    if (!key || key.includes("[redacted-secret]")) continue;
    const next = sanitizeMcpMetadata(rawValue, secrets, depth + 1);
    if (next !== undefined) sanitized[key] = next;
  }
  return sanitized;
}

function copyJsonObject(value: unknown, secrets: readonly string[] = []): Record<string, unknown> {
  const sanitized = sanitizeMcpMetadata(value, secrets);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {};
}

function classifyMcpToolRisk(raw: Record<string, unknown>): McpToolDescriptor["risk"] {
  const annotations = copyJsonObject(raw.annotations);
  if (annotations.readOnlyHint === true && annotations.destructiveHint !== true) return "read";
  const inferred = classifyAgentToolRisk(typeof raw.name === "string" ? raw.name : "");
  return inferred === "read" ? "external" : inferred;
}

function normalizeTool(
  server: McpAllowlistEntry,
  value: unknown,
  secrets: readonly string[],
): McpToolDescriptor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = copyJsonObject(value, secrets);
  if (
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    raw.name.includes("[redacted-secret]")
  ) return undefined;
  const risk = classifyMcpToolRisk(raw);
  const parsed = mcpToolDescriptorSchema.safeParse({
    name: raw.name.slice(0, 240),
    ...(typeof raw.title === "string" ? { title: raw.title.slice(0, 240) } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description.slice(0, 1_000) } : {}),
    inputSchema: copyJsonObject(raw.inputSchema, secrets),
    risk,
    requiresApproval: risk !== "read",
    serverId: server.id,
    provenance: {
      source: "mcp",
      serverId: server.id,
      transport: server.transport,
    },
  });
  return parsed.success ? parsed.data : undefined;
}

export type McpDiscoveryResult = {
  capabilities: Record<string, unknown>;
  tools: McpToolDescriptor[];
  checkedAt: string;
};

export async function discoverMcpServer(args: {
  server: McpAllowlistEntry;
  secret?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<McpDiscoveryResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = normalizeTrustedMcpUrl(args.server.url);
  const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 8_000, 500), 30_000);
  let requestId = 0;
  let sessionId: string | undefined;
  let initializedProtocol = false;

  const rpc = async (method: string, params: Record<string, unknown>) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(args.secret ? { Authorization: `Bearer ${args.secret}` } : {}),
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
          ...(initializedProtocol ? { "MCP-Protocol-Version": "2025-03-26" } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `registry_${++requestId}`,
          method,
          params,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new McpGatewayError(
          "mcp_gateway_unavailable",
          `The MCP server was unavailable (${response.status}).`,
        );
      }
      sessionId = response.headers.get("mcp-session-id") ?? sessionId;
      const payload = parseRpcPayload(
        response.headers.get("content-type")?.toLowerCase() ?? "",
        await response.text(),
      );
      if (payload.error) {
        throw new McpGatewayError("mcp_protocol_error", "The MCP server rejected the protocol request.");
      }
      return copyJsonObject(payload.result, args.secret ? [args.secret] : []);
    } catch (error) {
      if (error instanceof McpGatewayError) throw error;
      throw new McpGatewayError("mcp_gateway_unavailable", "The MCP server could not be reached.");
    } finally {
      clearTimeout(timeout);
    }
  };

  const initialized = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "conductor-mcp-registry", version: "1" },
  });
  initializedProtocol = true;
  {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(args.secret ? { Authorization: `Bearer ${args.secret}` } : {}),
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
          "MCP-Protocol-Version": "2025-03-26",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new McpGatewayError(
          "mcp_protocol_error",
          "The MCP server rejected the initialization notification.",
        );
      }
    } catch (error) {
      if (error instanceof McpGatewayError) throw error;
      throw new McpGatewayError("mcp_gateway_unavailable", "The MCP server could not be reached.");
    } finally {
      clearTimeout(timeout);
    }
  }
  const listed = await rpc("tools/list", {});
  const tools = Array.isArray(listed.tools)
    ? listed.tools.flatMap((tool) => {
        const normalized = normalizeTool(args.server, tool, args.secret ? [args.secret] : []);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    capabilities: copyJsonObject(initialized.capabilities, args.secret ? [args.secret] : []),
    tools,
    checkedAt: new Date().toISOString(),
  };
}
