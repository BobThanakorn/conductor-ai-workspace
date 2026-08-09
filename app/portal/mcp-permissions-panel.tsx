"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./mcp-permissions.module.css";

type McpToolRisk = "read" | "write" | "execute" | "external";
type McpDecision = "allow" | "deny" | "inherit";
type McpServerStatus = "registered" | "connected" | "disconnected" | "unavailable" | "revoked";

type McpTool = {
  name: string;
  title?: string;
  description?: string;
  risk: McpToolRisk;
  requiresApproval: boolean;
  serverId: string;
  provenance: {
    source: "mcp";
    serverId: string;
    transport: "streamable-http";
  };
};

type McpServer = {
  workspaceId: string;
  serverId: string;
  allowlistId: string;
  label: string;
  status: McpServerStatus;
  enabled: boolean;
  tools: McpTool[];
  lastErrorCode?: string;
  lastCheckedAt?: string;
};

type RegistryEvent = {
  sequence: number;
  id: string;
  serverId: string;
  type: string;
  status: McpServerStatus;
  detailCode?: string;
  createdAt: string;
};

type RegistryResponse = {
  ok: true;
  workspaceId: string;
  registrationOptions: Array<{ id: string; label: string; transport: "streamable-http" }>;
  servers: McpServer[];
  events: RegistryEvent[];
};

type McpPolicy = {
  workspaceId: string;
  scopeType: "workspace" | "agent";
  scopeId: string;
  serverId: string;
  toolName: string;
  decision: McpDecision;
  risk: McpToolRisk;
  requiresApproval: boolean;
  revision: number;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

type EffectivePolicy = {
  serverId: string;
  toolName: string;
  title?: string;
  description?: string;
  risk: McpToolRisk;
  requiresApproval: boolean;
  workspaceDecision: McpDecision;
  agentDecision: McpDecision;
  effectiveDecision: "allow" | "deny";
  reason: string;
};

type PolicyEvent = {
  sequence: number;
  id: string;
  workspaceId: string;
  scopeType: "workspace" | "agent";
  scopeId: string;
  serverId: string;
  toolName: string;
  risk: McpToolRisk;
  previousDecision: McpDecision;
  decision: McpDecision;
  previousRevision: number;
  revision: number;
  actorId: string;
  createdAt: string;
};

type PolicyResponse = {
  ok: true;
  workspaceId: string;
  revision: number;
  agentId?: string;
  policies: McpPolicy[];
  effective: EffectivePolicy[];
  events: PolicyEvent[];
};

type ApiFailure = { error?: string | { message?: string }; message?: string };

async function readApi<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & ApiFailure;
  if (!response.ok) {
    const detail = typeof payload.error === "string"
      ? payload.error
      : payload.error?.message ?? payload.message;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return payload;
}

function riskLabel(risk: McpToolRisk) {
  return ({ read: "Read", write: "Write", execute: "Execute", external: "External" } as const)[risk];
}

function formatDate(value?: string) {
  if (!value) return "Not checked";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

async function loadMcpState(workspaceId: string, policyUrl: string) {
  const registryUrl = `/api/mcp?${new URLSearchParams({ workspaceId })}`;
  return Promise.all([
    fetch(registryUrl, { cache: "no-store" }).then(readApi<RegistryResponse>),
    fetch(policyUrl, { cache: "no-store" }).then(readApi<PolicyResponse>),
  ]);
}

export function McpPermissionsPanel({ workspaceId }: { workspaceId: string }) {
  const [registry, setRegistry] = useState<RegistryResponse | null>(null);
  const [policyState, setPolicyState] = useState<PolicyResponse | null>(null);
  const [scopeType, setScopeType] = useState<"workspace" | "agent">("workspace");
  const [agentIdInput, setAgentIdInput] = useState("");
  const [activeAgentId, setActiveAgentId] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [registrationId, setRegistrationId] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const policyUrl = useMemo(() => {
    const query = new URLSearchParams({ workspaceId });
    if (scopeType === "agent" && activeAgentId) query.set("agentId", activeAgentId);
    return `/api/mcp/policies?${query}`;
  }, [activeAgentId, scopeType, workspaceId]);

  const refresh = useCallback(async () => {
    try {
      const [nextRegistry, nextPolicies] = await loadMcpState(workspaceId, policyUrl);
      setRegistry(nextRegistry);
      setPolicyState(nextPolicies);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "MCP control center is unavailable.");
    }
  }, [policyUrl, workspaceId]);

  useEffect(() => {
    let current = true;
    void loadMcpState(workspaceId, policyUrl).then(([nextRegistry, nextPolicies]) => {
      if (!current) return;
      setRegistry(nextRegistry);
      setPolicyState(nextPolicies);
      setError("");
    }).catch((failure: unknown) => {
      if (current) setError(failure instanceof Error ? failure.message : "MCP control center is unavailable.");
    });
    return () => { current = false; };
  }, [policyUrl, workspaceId]);

  const requireAdministrator = () => {
    const token = adminToken.trim();
    if (!token) {
      setError("Enter the MCP administrator token before changing servers or policies.");
      return null;
    }
    return token;
  };

  async function postRegistry(body: Record<string, unknown>, actionKey: string, success: string) {
    const token = requireAdministrator();
    if (!token) return;
    setPendingAction(actionKey);
    setError("");
    setNotice("");
    try {
      await fetch("/api/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Conductor-MCP-Admin": token,
        },
        body: JSON.stringify({ workspaceId, ...body }),
      }).then(readApi<{ ok: true; server: McpServer }>);
      setNotice(success);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The MCP server action failed.");
    } finally {
      setPendingAction("");
    }
  }

  async function registerServer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!effectiveRegistrationId) return;
    await postRegistry(
      { action: "register", allowlistId: effectiveRegistrationId },
      `register:${effectiveRegistrationId}`,
      "The allowlisted MCP server was registered.",
    );
  }

  async function changePolicy(tool: EffectivePolicy, decision: McpDecision) {
    const token = requireAdministrator();
    if (!token || !policyState) return;
    if (scopeType === "agent" && !activeAgentId) {
      setError("Load an agent ID before changing an agent policy.");
      return;
    }
    const actionKey = `policy:${scopeType}:${tool.serverId}:${tool.toolName}:${decision}`;
    setPendingAction(actionKey);
    setError("");
    setNotice("");
    try {
      await fetch("/api/mcp/policies", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Conductor-MCP-Admin": token,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          workspaceId,
          expectedRevision: policyState.revision,
          scope: scopeType === "workspace"
            ? { type: "workspace" }
            : { type: "agent", agentId: activeAgentId },
          serverId: tool.serverId,
          toolName: tool.toolName,
          decision,
        }),
      }).then(readApi<{ ok: true; revision: number; policy: McpPolicy; effective: EffectivePolicy[] }>);
      setNotice(`${tool.title || tool.toolName} policy updated to ${decision}.`);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The MCP policy update failed.");
    } finally {
      setPendingAction("");
    }
  }

  function loadAgentPolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = agentIdInput.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(next)) {
      setError("Enter a valid agent ID using letters, numbers, dot, underscore, colon, or dash.");
      return;
    }
    setError("");
    setActiveAgentId(next);
  }

  const registeredIds = new Set((registry?.servers ?? []).map((server) => server.allowlistId));
  const availableRegistrationOptions = (registry?.registrationOptions ?? []).filter(
    (option) => !registeredIds.has(option.id),
  );
  const effectiveRegistrationId = availableRegistrationOptions.some((option) => option.id === registrationId)
    ? registrationId
    : availableRegistrationOptions[0]?.id ?? "";
  const currentScopeId = scopeType === "workspace" ? workspaceId : activeAgentId;

  return (
    <section className={styles.panel} aria-labelledby="mcp-control-center-heading">
      <header className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>MCP CONTROL CENTER</span>
          <h1 id="mcp-control-center-heading">Servers, tools, and permissions</h1>
          <p>Every tool starts denied. An explicit workspace policy is required before an agent can inherit or narrow access.</p>
        </div>
        <button type="button" className={styles.secondaryButton} onClick={() => void refresh()} disabled={Boolean(pendingAction)}>
          Refresh state
        </button>
      </header>

      <div className={styles.defaultDeny} role="note">
        <span aria-hidden="true">◆</span>
        <div>
          <strong>Default deny is enforced by the server</strong>
          <p>Missing, revoked, unavailable, or inherited-without-allow policies remain denied. Write, execute, and external tools always keep their approval requirement.</p>
        </div>
      </div>

      <label className={styles.secretField}>
        <span>MCP administrator token</span>
        <input
          type="password"
          value={adminToken}
          onChange={(event) => setAdminToken(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="mcp-token-help"
        />
        <small id="mcp-token-help">Held only in this tab memory. It is never stored, added to context, or included in audit events.</small>
      </label>

      {error && <div className={styles.error} role="alert">{error}</div>}
      {notice && <div className={styles.notice} role="status">{notice}</div>}

      <section className={styles.section} aria-labelledby="mcp-servers-heading">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="mcp-servers-heading">Server lifecycle</h2>
            <p>Only administrator-allowlisted endpoints can be registered.</p>
          </div>
          <span>{registry?.servers.length ?? 0} registered</span>
        </div>

        {availableRegistrationOptions.length > 0 && (
          <form className={styles.registrationForm} onSubmit={registerServer}>
            <label>
              <span>Allowlisted server</span>
              <select value={effectiveRegistrationId} onChange={(event) => setRegistrationId(event.target.value)}>
                {availableRegistrationOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label} · {option.transport}</option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={!effectiveRegistrationId || Boolean(pendingAction)}>
              {pendingAction.startsWith("register:") ? "Registering…" : "Register server"}
            </button>
          </form>
        )}

        <div className={styles.serverGrid}>
          {(registry?.servers ?? []).map((server) => (
            <article className={styles.serverCard} key={server.serverId}>
              <header>
                <div>
                  <strong>{server.label}</strong>
                  <code>{server.serverId}</code>
                </div>
                <span className={`${styles.status} ${styles[server.status]}`}>{server.status}</span>
              </header>
              <dl>
                <div><dt>Runtime</dt><dd>{server.enabled ? "Enabled" : "Disabled"}</dd></div>
                <div><dt>Discovered tools</dt><dd>{server.tools.length}</dd></div>
                <div><dt>Last checked</dt><dd>{formatDate(server.lastCheckedAt)}</dd></div>
                {server.lastErrorCode && <div><dt>Failure code</dt><dd><code>{server.lastErrorCode}</code></dd></div>}
              </dl>
              <div className={styles.actions} aria-label={`${server.label} lifecycle actions`}>
                {server.status !== "connected" && server.status !== "revoked" && (
                  <button type="button" onClick={() => void postRegistry({ action: "connect", serverId: server.serverId }, `connect:${server.serverId}`, `${server.label} connected.`)} disabled={Boolean(pendingAction)}>Connect</button>
                )}
                {server.status === "connected" && (
                  <button type="button" onClick={() => void postRegistry({ action: "disconnect", serverId: server.serverId }, `disconnect:${server.serverId}`, `${server.label} disconnected.`)} disabled={Boolean(pendingAction)}>Disconnect</button>
                )}
                {server.status !== "revoked" && <>
                  <button type="button" onClick={() => void postRegistry({ action: "check_health", serverId: server.serverId }, `health:${server.serverId}`, `${server.label} health checked.`)} disabled={Boolean(pendingAction)}>Check health</button>
                  <button type="button" onClick={() => void postRegistry({ action: "refresh", serverId: server.serverId }, `refresh:${server.serverId}`, `${server.label} capabilities refreshed.`)} disabled={Boolean(pendingAction)}>Refresh tools</button>
                  <button type="button" className={styles.dangerButton} onClick={() => {
                    if (window.confirm(`Revoke ${server.label}? Its tools will be denied immediately.`)) {
                      void postRegistry({ action: "revoke", serverId: server.serverId }, `revoke:${server.serverId}`, `${server.label} revoked.`);
                    }
                  }} disabled={Boolean(pendingAction)}>Revoke</button>
                </>}
              </div>
            </article>
          ))}
        </div>
        {registry && registry.servers.length === 0 && <p className={styles.empty}>No MCP server is registered in this workspace.</p>}
      </section>

      <section className={styles.section} aria-labelledby="mcp-permissions-heading">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="mcp-permissions-heading">Least-privilege tool policy</h2>
            <p>Workspace access is the ceiling. Agent policy can inherit or further restrict it.</p>
          </div>
          <span>Revision {policyState?.revision ?? "—"}</span>
        </div>

        <div className={styles.scopeControls}>
          <fieldset>
            <legend>Policy scope</legend>
            <label>
              <input type="radio" name="mcp-policy-scope" checked={scopeType === "workspace"} onChange={() => { setScopeType("workspace"); setActiveAgentId(""); }} />
              Workspace
            </label>
            <label>
              <input type="radio" name="mcp-policy-scope" checked={scopeType === "agent"} onChange={() => setScopeType("agent")} />
              Agent
            </label>
          </fieldset>
          {scopeType === "agent" && (
            <form onSubmit={loadAgentPolicy}>
              <label>
                <span>Agent ID</span>
                <input value={agentIdInput} onChange={(event) => setAgentIdInput(event.target.value)} autoComplete="off" />
              </label>
              <button type="submit">Load agent policy</button>
            </form>
          )}
        </div>

        {scopeType === "agent" && !activeAgentId ? (
          <p className={styles.empty}>Enter an agent ID to inspect and change its effective permissions.</p>
        ) : (
          <div className={styles.toolList} aria-live="polite">
            {(policyState?.effective ?? []).map((tool) => {
              const explicit = policyState?.policies.find((policy) =>
                policy.scopeType === scopeType &&
                policy.scopeId === currentScopeId &&
                policy.serverId === tool.serverId &&
                policy.toolName === tool.toolName
              )?.decision ?? "inherit";
              const actionPrefix = `policy:${scopeType}:${tool.serverId}:${tool.toolName}:`;
              const sideEffect = tool.risk !== "read" || tool.requiresApproval;
              const agentAllowBlocked = scopeType === "agent" && tool.workspaceDecision !== "allow";
              return (
                <article className={styles.toolCard} key={`${tool.serverId}:${tool.toolName}`}>
                  <div className={styles.toolSummary}>
                    <div>
                      <strong>{tool.title || tool.toolName}</strong>
                      <code>{tool.toolName}</code>
                    </div>
                    <div className={styles.badges}>
                      <span className={`${styles.risk} ${styles[`risk_${tool.risk}`]}`}>{riskLabel(tool.risk)}</span>
                      <span className={sideEffect ? styles.approval : styles.readOnly}>{sideEffect ? "Approval required" : "Read-only"}</span>
                      <span className={tool.effectiveDecision === "allow" ? styles.allowed : styles.denied}>{tool.effectiveDecision === "allow" ? "Allowed" : "Denied"}</span>
                    </div>
                  </div>
                  <p>{tool.description || "No description was reported by this MCP server."}</p>
                  <div className={styles.provenance}>
                    <span>Provenance</span>
                    <code>MCP · {tool.serverId} · streamable-http</code>
                  </div>
                  <dl className={styles.decisionGrid}>
                    <div><dt>Workspace</dt><dd>{tool.workspaceDecision}</dd></div>
                    <div><dt>Agent</dt><dd>{tool.agentDecision}</dd></div>
                    <div><dt>Effective reason</dt><dd>{tool.reason.replaceAll("_", " ")}</dd></div>
                    <div><dt>This scope</dt><dd>{explicit}</dd></div>
                  </dl>
                  <div className={styles.actions} aria-label={`${tool.title || tool.toolName} policy actions`}>
                    <button
                      type="button"
                      onClick={() => void changePolicy(tool, "allow")}
                      disabled={Boolean(pendingAction) || agentAllowBlocked || explicit === "allow"}
                      title={agentAllowBlocked ? "An agent cannot exceed the workspace allow policy." : undefined}
                    >Allow</button>
                    <button type="button" onClick={() => void changePolicy(tool, "deny")} disabled={Boolean(pendingAction) || explicit === "deny"}>Deny</button>
                    <button type="button" onClick={() => void changePolicy(tool, "inherit")} disabled={Boolean(pendingAction) || explicit === "inherit"}>
                      {scopeType === "workspace" ? "Reset to default" : "Inherit workspace"}
                    </button>
                    {pendingAction.startsWith(actionPrefix) && <span role="status">Saving…</span>}
                  </div>
                </article>
              );
            })}
            {policyState && policyState.effective.length === 0 && <p className={styles.empty}>No tools have been discovered from connected MCP servers.</p>}
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="mcp-audit-heading">
        <div className={styles.sectionHeading}>
          <div>
            <h2 id="mcp-audit-heading">Append-only audit</h2>
            <p>Registry and policy transitions are recorded by the server; secrets and tool arguments are excluded.</p>
          </div>
          <span>{(registry?.events.length ?? 0) + (policyState?.events.length ?? 0)} events</span>
        </div>
        <div className={styles.auditColumns}>
          <div>
            <h3>Policy decisions</h3>
            <ol className={styles.auditList}>
              {(policyState?.events ?? []).map((event) => (
                <li key={event.id}>
                  <span className={styles.auditMarker} aria-hidden="true" />
                  <div>
                    <strong>{event.decision} · {event.toolName}</strong>
                    <span>{event.scopeType}:{event.scopeId} · revision {event.revision} · {event.actorId}</span>
                    <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
                  </div>
                </li>
              ))}
            </ol>
            {policyState && policyState.events.length === 0 && <p className={styles.empty}>No policy decision has been recorded.</p>}
          </div>
          <div>
            <h3>Server lifecycle</h3>
            <ol className={styles.auditList}>
              {(registry?.events ?? []).map((event) => (
                <li key={event.id}>
                  <span className={styles.auditMarker} aria-hidden="true" />
                  <div>
                    <strong>{event.type}</strong>
                    <span>{event.serverId} · {event.status}{event.detailCode ? ` · ${event.detailCode}` : ""}</span>
                    <time dateTime={event.createdAt}>{formatDate(event.createdAt)}</time>
                  </div>
                </li>
              ))}
            </ol>
            {registry && registry.events.length === 0 && <p className={styles.empty}>No server lifecycle event has been recorded.</p>}
          </div>
        </div>
      </section>
    </section>
  );
}
