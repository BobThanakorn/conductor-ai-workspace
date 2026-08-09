"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./automations-panel.module.css";

type Profile = {
  id: string;
  kind: "agent" | "skill";
  version: number;
  name: string;
  definition_json: string;
  created_at: string;
};
type Automation = {
  id: string;
  name: string;
  enabled: number;
  trigger_json: string;
  agent_profile_id: string;
  agent_profile_version: number;
  skill_profile_id: string;
  skill_profile_version: number;
  next_run_at?: string | null;
};
type Run = {
  id: string;
  automation_id: string;
  status: string;
  task_id?: string;
  snapshot_id: string;
  created_at: string;
  cancel_requested: number;
};
type RunEvent = { event_id: string; run_id: string; type: string; detail_json: string; created_at: string };
type Snapshot = { id: string; run_id: string; manifest_json: string; created_at: string };
type State = { profiles: Profile[]; automations: Automation[]; runs: Run[]; events: RunEvent[]; snapshots: Snapshot[] };
type TriggerKind = "manual" | "schedule" | "webhook" | "command";

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function profileKey(profile: Profile) { return `${profile.id}@${profile.version}`; }

export function AutomationsPanel({
  workspaceId,
  identity,
  onIdentityChange,
}: {
  workspaceId: string;
  identity: string;
  onIdentityChange: (value: string) => void;
}) {
  const [state, setState] = useState<State>({ profiles: [], automations: [], runs: [], events: [], snapshots: [] });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [profileKind, setProfileKind] = useState<"agent" | "skill">("agent");
  const [profileId, setProfileId] = useState("");
  const [profileName, setProfileName] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("ตอบเป็นภาษาไทย วางแผนและเสนอการเปลี่ยนแปลงโดยรอการอนุมัติจากผู้ใช้ก่อนทุก mutation");
  const [agentModel, setAgentModel] = useState("");
  const [skillNames, setSkillNames] = useState("repository-search, test-runner");
  const [automationName, setAutomationName] = useState("");
  const [triggerKind, setTriggerKind] = useState<TriggerKind>("manual");
  const [scheduleMinutes, setScheduleMinutes] = useState(15);
  const [hookId, setHookId] = useState("review-hook");
  const [commandName, setCommandName] = useState("daily-review");
  const [agentProfile, setAgentProfile] = useState("");
  const [skillProfile, setSkillProfile] = useState("");

  const headers = useMemo(() => ({
    "content-type": "application/json",
    ...(identity.trim() ? { "x-conductor-identity": identity.trim() } : {}),
  }), [identity]);

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/automations?workspaceId=${encodeURIComponent(workspaceId)}`, { headers, cache: "no-store" });
    const payload = await response.json() as State & { error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message ?? "Unable to load automations.");
    setState(payload);
    const latestAgent = payload.profiles.find((profile) => profile.kind === "agent");
    const latestSkill = payload.profiles.find((profile) => profile.kind === "skill");
    setAgentProfile((current) => current || (latestAgent ? profileKey(latestAgent) : ""));
    setSkillProfile((current) => current || (latestSkill ? profileKey(latestSkill) : ""));
  }, [headers, workspaceId]);

  // Initial remote state is synchronized from the owner-scoped API.
  useEffect(() => {
    if (!identity.trim() && typeof window !== "undefined" && window.location.hostname === "localhost") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh().then(() => setError("")).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Unable to load automations."));
  }, [identity, refresh]);

  async function post(body: Record<string, unknown>, success: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/automations", { method: "POST", headers, body: JSON.stringify({ workspaceId, ...body }) });
      const payload = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Automation request failed.");
      setNotice(success);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Automation request failed.");
    } finally { setBusy(false); }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    const normalizedId = profileId.trim().toLowerCase();
    const definition = profileKind === "agent"
      ? { systemPrompt: agentPrompt.trim(), ...(agentModel.trim() ? { model: agentModel.trim() } : {}), maxSteps: 8 }
      : { skills: skillNames.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean) };
    await post({ action: "profile", profileId: normalizedId, kind: profileKind, name: profileName.trim(), definition }, `Saved ${profileKind} profile ${normalizedId} as a new immutable version.`);
  }

  async function saveAutomation(event: FormEvent) {
    event.preventDefault();
    const agent = state.profiles.find((profile) => profile.kind === "agent" && profileKey(profile) === agentProfile);
    const skill = state.profiles.find((profile) => profile.kind === "skill" && profileKey(profile) === skillProfile);
    if (!agent || !skill) { setError("Select an exact agent and skill profile version."); return; }
    const trigger = triggerKind === "schedule"
      ? { type: "schedule", every: `*/${scheduleMinutes} * * * *` }
      : triggerKind === "webhook"
        ? { type: "webhook", hookId: hookId.trim() }
        : triggerKind === "command"
          ? { type: "command", command: commandName.trim() }
          : { type: "manual" };
    await post({
      action: "automation",
      automationId: `automation-${crypto.randomUUID()}`,
      name: automationName.trim(),
      trigger,
      agentProfileId: agent.id,
      agentProfileVersion: agent.version,
      skillProfileId: skill.id,
      skillProfileVersion: skill.version,
    }, `Saved automation “${automationName.trim()}”.`);
    setAutomationName("");
  }

  const agentProfiles = state.profiles.filter((profile) => profile.kind === "agent");
  const skillProfiles = state.profiles.filter((profile) => profile.kind === "skill");

  return <section className={styles.panel} aria-labelledby="automations-heading">
    <header className={styles.heading}>
      <div><p className={styles.eyebrow}>DURABLE WORKFLOWS</p><h1 id="automations-heading">Automations</h1><p>Queued prompts and schedules create isolated, approval-gated tasks. No run can approve, apply, commit, push, merge, or publish itself.</p></div>
      <button type="button" onClick={() => void refresh().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Refresh failed."))} disabled={busy}>Refresh</button>
    </header>

    <label className={styles.identity}><span>Signed human identity <small>(required for local use)</small></span><input type="password" value={identity} onChange={(event) => onIdentityChange(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste a short-lived signed human token" /><small>Kept only in page memory. Hosted deployments may use a verified platform identity instead.</small></label>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}

    <div className={styles.grid}>
      <form className={styles.card} onSubmit={saveProfile}>
        <div className={styles.cardTitle}><div><h2>Reusable profiles</h2><p>Saving the same profile ID creates a new immutable version.</p></div><span>{state.profiles.length}</span></div>
        <div className={styles.twoColumns}><label>Profile type<select value={profileKind} onChange={(event) => setProfileKind(event.target.value as "agent" | "skill")}><option value="agent">Agent</option><option value="skill">Skills</option></select></label><label>Stable profile ID<input value={profileId} onChange={(event) => setProfileId(event.target.value)} pattern="[a-z][a-z0-9._-]{0,63}" placeholder="thai-code-review" required /></label></div>
        <label>Display name<input value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={120} required /></label>
        {profileKind === "agent" ? <><label>System prompt<textarea value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} rows={5} maxLength={8000} required /></label><label>Model override <small>(optional)</small><input value={agentModel} onChange={(event) => setAgentModel(event.target.value)} placeholder="gpt-5.1-codex-mini" /></label></> : <label>Allowlisted skills <small>(comma-separated)</small><input value={skillNames} onChange={(event) => setSkillNames(event.target.value)} placeholder="repository-search, test-runner" /></label>}
        <button type="submit" disabled={busy}>Save new version</button>
        <ul className={styles.compactList}>{state.profiles.map((profile) => <li key={profileKey(profile)}><strong>{profile.name}</strong><span>{profile.kind} · {profile.id}@{profile.version}</span></li>)}</ul>
      </form>

      <form className={styles.card} onSubmit={saveAutomation}>
        <div className={styles.cardTitle}><div><h2>Trigger builder</h2><p>Bind an exact agent and skill version to a bounded trigger.</p></div><span>{state.automations.length}</span></div>
        <label>Automation name<input value={automationName} onChange={(event) => setAutomationName(event.target.value)} maxLength={120} required /></label>
        <div className={styles.twoColumns}><label>Agent profile<select value={agentProfile} onChange={(event) => setAgentProfile(event.target.value)} required><option value="">Select…</option>{agentProfiles.map((profile) => <option key={profileKey(profile)} value={profileKey(profile)}>{profile.name} · v{profile.version}</option>)}</select></label><label>Skill profile<select value={skillProfile} onChange={(event) => setSkillProfile(event.target.value)} required><option value="">Select…</option>{skillProfiles.map((profile) => <option key={profileKey(profile)} value={profileKey(profile)}>{profile.name} · v{profile.version}</option>)}</select></label></div>
        <label>Trigger<select value={triggerKind} onChange={(event) => setTriggerKind(event.target.value as TriggerKind)}><option value="manual">Manual</option><option value="schedule">Schedule</option><option value="webhook">Signed webhook</option><option value="command">Allowlisted command</option></select></label>
        {triggerKind === "schedule" && <label>Every N minutes<input type="number" min={1} max={59} value={scheduleMinutes} onChange={(event) => setScheduleMinutes(Number(event.target.value))} required /></label>}
        {triggerKind === "webhook" && <label>Webhook ID<input value={hookId} onChange={(event) => setHookId(event.target.value)} pattern="[a-z][a-z0-9._-]{0,63}" required /></label>}
        {triggerKind === "command" && <label>Named command<input value={commandName} onChange={(event) => setCommandName(event.target.value)} pattern="[a-z][a-z0-9._-]{0,63}" required /></label>}
        <button type="submit" disabled={busy || !agentProfiles.length || !skillProfiles.length}>Save automation</button>
      </form>
    </div>

    <section className={styles.card} aria-labelledby="configured-automations"><div className={styles.cardTitle}><div><h2 id="configured-automations">Configured automations</h2><p>Schedules run only through the signed scheduler endpoint; webhooks require raw-body HMAC verification.</p></div></div><div className={styles.rows}>{state.automations.length ? state.automations.map((automation) => { const trigger = parseJson<Record<string, string>>(automation.trigger_json, { type: "invalid" }); const canRun = trigger.type === "manual" || trigger.type === "command"; return <article key={automation.id} className={styles.row}><div><strong>{automation.name}</strong><span>{trigger.type}{trigger.every ? ` · ${trigger.every}` : ""}{trigger.hookId ? ` · ${trigger.hookId}` : ""}{trigger.command ? ` · ${trigger.command}` : ""}</span><small>{automation.agent_profile_id}@{automation.agent_profile_version} + {automation.skill_profile_id}@{automation.skill_profile_version}{automation.next_run_at ? ` · next ${new Date(automation.next_run_at).toLocaleString()}` : ""}</small></div><div className={styles.actions}>{canRun && <button type="button" disabled={busy || !automation.enabled} onClick={() => void post({ action: "run", automationId: automation.id, ...(trigger.type === "command" ? { command: trigger.command } : {}), idempotencyKey: `manual:${crypto.randomUUID()}` }, "Run queued for approval-gated execution.")}>Run</button>}<button type="button" disabled={busy} onClick={() => void post({ action: automation.enabled ? "pause" : "resume", automationId: automation.id }, automation.enabled ? "Automation paused." : "Automation resumed.")}>{automation.enabled ? "Pause" : "Resume"}</button></div></article>; }) : <p className={styles.empty}>No automation configured yet.</p>}</div></section>

    <section className={styles.card} aria-labelledby="run-history"><div className={styles.cardTitle}><div><h2 id="run-history">Run history and audit</h2><p>Every run is owner-scoped, snapshot-bound, cancellable, replayable, and linked to append-only events.</p></div><span>{state.runs.length}</span></div><div className={styles.rows}>{state.runs.length ? state.runs.map((run) => { const events = state.events.filter((item) => item.run_id === run.id); const snapshot = state.snapshots.find((item) => item.run_id === run.id); const manifest = snapshot ? parseJson<{ workspace?: { headSha?: string } }>(snapshot.manifest_json, {}) : {}; return <details key={run.id} className={styles.run}><summary><span><strong>{run.status}</strong><small>{run.task_id ?? "task not materialized"} · {new Date(run.created_at).toLocaleString()}</small></span><code>{run.id.slice(0, 12)}</code></summary><div className={styles.runBody}><p>Snapshot <code>{run.snapshot_id.slice(0, 16)}</code>{manifest.workspace?.headSha ? <> · head <code>{manifest.workspace.headSha.slice(0, 12)}</code></> : null}</p><ol>{events.map((item) => <li key={item.event_id}><strong>{item.type}</strong><span>{new Date(item.created_at).toLocaleString()}</span><pre>{JSON.stringify(parseJson(item.detail_json, {}), null, 2)}</pre></li>)}</ol><div className={styles.actions}><button type="button" disabled={busy || ["completed", "cancelled"].includes(run.status)} onClick={() => void post({ action: "cancel", runId: run.id }, "Run and pending approvals cancelled.")}>Cancel</button><button type="button" disabled={busy} onClick={() => void post({ action: "replay", runId: run.id }, "Replay created a new snapshot-bound run.")}>Replay as new run</button></div></div></details>; }) : <p className={styles.empty}>No run recorded yet.</p>}</div></section>
  </section>;
}
