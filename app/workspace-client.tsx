"use client";

import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useState,
} from "react";

import "./workspace.css";

type ViewMode = "diff" | "code";
type ApprovalState = "pending" | "approved" | "denied";
type BottomPanel = "terminal" | "git";
type EventState = "complete" | "active" | "waiting" | "queued";
type ApiState = "connecting" | "connected" | "preview";

type TimelineEvent = {
  id: string;
  title: string;
  detail: string;
  time: string;
  state: EventState;
};

type DiffLine = {
  oldLine?: number;
  newLine?: number;
  kind: "context" | "addition" | "deletion" | "fold";
  content: string;
};

type WorkspaceMeta = {
  name: string;
  repository: string;
  branch: string;
  baseBranch: string;
  taskId: string;
  taskTitle: string;
};

type WorkspaceApiResponse = {
  workspace?: Partial<{
    name: string;
    repository: string | { name?: string };
    repo: string;
    branch: string;
    baseBranch: string;
    taskId: string;
    taskTitle: string;
  }>;
  tasks?: Array<Partial<{ id: string; title: string; status: string }>>;
  approvals?: Array<Partial<{ id: string; status: string }>>;
  events?: Array<
    Partial<{
      id: string;
      title: string;
      detail: string;
      createdAt: string;
      state: EventState;
    }>
  >;
};

const INITIAL_WORKSPACE: WorkspaceMeta = {
  name: "Atlas Engineering",
  repository: "openframe/atlas-web",
  branch: "agent/harden-session-validation",
  baseBranch: "main",
  taskId: "task_harden_sessions",
  taskTitle: "Harden session validation",
};

const INITIAL_TIMELINE: TimelineEvent[] = [
  {
    id: "event-1",
    title: "Task understood",
    detail: "Mapped acceptance criteria and trust boundaries",
    time: "10:42:08",
    state: "complete",
  },
  {
    id: "event-2",
    title: "Context assembled",
    detail: "12 sources · 6,842 tokens · snapshot 8f2c1d7",
    time: "10:42:14",
    state: "complete",
  },
  {
    id: "event-3",
    title: "Patch prepared",
    detail: "3 files changed · +48 −12",
    time: "10:43:31",
    state: "complete",
  },
  {
    id: "event-4",
    title: "Approval required",
    detail: "Run repository test suite in the task sandbox",
    time: "10:43:34",
    state: "active",
  },
  {
    id: "event-5",
    title: "Verify and review",
    detail: "Waiting for approved test execution",
    time: "—",
    state: "queued",
  },
];

const FILE_CONTENT: Record<string, string[]> = {
  "src/agent/workspace-agent.ts": [
    'import { run, tool } from "@openai/agents";',
    'import { policyGate } from "../policy/policy";',
    'import type { WorkspaceContext } from "./context";',
    "",
    "export async function executeWorkspaceTask(",
    "  context: WorkspaceContext,",
    "  request: AgentRequest,",
    ") {",
    "  const capability = await policyGate.evaluate({",
    "    actor: request.actor,",
    "    workspace: context.workspaceId,",
    "    action: request.action,",
    "    snapshot: context.snapshot,",
    "  });",
    "",
    "  if (capability.requiresApproval) {",
    "    return suspendForApproval(capability);",
    "  }",
    "",
    "  return run(workspaceAgent, request.prompt, { context });",
    "}",
  ],
  "src/policy/policy.ts": [
    'import { createHash } from "node:crypto";',
    'import type { ActionIntent, PolicyDecision } from "./types";',
    "",
    "const MUTATING_ACTIONS = new Set([",
    '  "filesystem.write",',
    '  "git.commit",',
    '  "git.push",',
    '  "provider.pull_request.create",',
    "]);",
    "",
    "export function evaluateIntent(intent: ActionIntent): PolicyDecision {",
    "  const actionDigest = createHash(\"sha256\")",
    "    .update(JSON.stringify(intent))",
    '    .digest("hex");',
    "",
    "  return {",
    "    actionDigest,",
    "    effect: MUTATING_ACTIONS.has(intent.action) ? \"approval\" : \"allow\",",
    "    expiresInSeconds: 300,",
    "  };",
    "}",
  ],
  "tests/approval.test.ts": [
    'import { describe, expect, it } from "vitest";',
    'import { evaluateIntent } from "../src/policy/policy";',
    "",
    'describe("workspace approvals", () => {',
    '  it("requires approval for persistent mutations", () => {',
    "    const decision = evaluateIntent({",
    '      action: "git.push",',
    '      workspaceId: "ws_local",',
    '      branch: "agent/policy-guardrails",',
    "    });",
    "",
    '    expect(decision.effect).toBe("approval");',
    "    expect(decision.actionDigest).toHaveLength(64);",
    "  });",
    "});",
  ],
};

const DIFF_CONTENT: Record<string, DiffLine[]> = {
  "src/agent/workspace-agent.ts": [
    { kind: "fold", content: "@@ -1,8 +1,10 @@" },
    { oldLine: 1, newLine: 1, kind: "context", content: 'import { run, tool } from "@openai/agents";' },
    { newLine: 2, kind: "addition", content: 'import { policyGate } from "../policy/policy";' },
    { oldLine: 2, newLine: 3, kind: "context", content: 'import type { WorkspaceContext } from "./context";' },
    { oldLine: 3, newLine: 4, kind: "context", content: "" },
    { oldLine: 4, newLine: 5, kind: "context", content: "export async function executeWorkspaceTask(" },
    { oldLine: 5, newLine: 6, kind: "context", content: "  context: WorkspaceContext," },
    { oldLine: 6, newLine: 7, kind: "context", content: "  request: AgentRequest," },
    { oldLine: 7, newLine: 8, kind: "context", content: ") {" },
    { oldLine: 8, kind: "deletion", content: "  return run(workspaceAgent, request.prompt, { context });" },
    { newLine: 9, kind: "addition", content: "  const capability = await policyGate.evaluate({" },
    { newLine: 10, kind: "addition", content: "    actor: request.actor," },
    { newLine: 11, kind: "addition", content: "    workspace: context.workspaceId," },
    { newLine: 12, kind: "addition", content: "    action: request.action," },
    { newLine: 13, kind: "addition", content: "    snapshot: context.snapshot," },
    { newLine: 14, kind: "addition", content: "  });" },
    { newLine: 15, kind: "addition", content: "" },
    { newLine: 16, kind: "addition", content: "  if (capability.requiresApproval) {" },
    { newLine: 17, kind: "addition", content: "    return suspendForApproval(capability);" },
    { newLine: 18, kind: "addition", content: "  }" },
    { newLine: 19, kind: "addition", content: "" },
    { newLine: 20, kind: "addition", content: "  return run(workspaceAgent, request.prompt, { context });" },
    { oldLine: 9, newLine: 21, kind: "context", content: "}" },
  ],
  "src/policy/policy.ts": [
    { kind: "fold", content: "@@ -7,10 +7,18 @@" },
    { oldLine: 7, newLine: 7, kind: "context", content: "export function evaluateIntent(intent: ActionIntent) {" },
    { oldLine: 8, kind: "deletion", content: "  return MUTATING_ACTIONS.has(intent.action);" },
    { newLine: 8, kind: "addition", content: "  const actionDigest = createHash(\"sha256\")" },
    { newLine: 9, kind: "addition", content: "    .update(JSON.stringify(intent))" },
    { newLine: 10, kind: "addition", content: '    .digest("hex");' },
    { newLine: 11, kind: "addition", content: "" },
    { newLine: 12, kind: "addition", content: "  return {" },
    { newLine: 13, kind: "addition", content: "    actionDigest," },
    { newLine: 14, kind: "addition", content: "    effect: MUTATING_ACTIONS.has(intent.action) ? \"approval\" : \"allow\"," },
    { newLine: 15, kind: "addition", content: "    expiresInSeconds: 300," },
    { newLine: 16, kind: "addition", content: "  };" },
    { oldLine: 9, newLine: 17, kind: "context", content: "}" },
  ],
  "tests/approval.test.ts": [
    { kind: "fold", content: "@@ -0,0 +1,15 @@" },
    { newLine: 1, kind: "addition", content: 'import { describe, expect, it } from "vitest";' },
    { newLine: 2, kind: "addition", content: 'import { evaluateIntent } from "../src/policy/policy";' },
    { newLine: 3, kind: "addition", content: "" },
    { newLine: 4, kind: "addition", content: 'describe("workspace approvals", () => {' },
    { newLine: 5, kind: "addition", content: '  it("requires approval for persistent mutations", () => {' },
    { newLine: 6, kind: "addition", content: "    const decision = evaluateIntent({" },
    { newLine: 7, kind: "addition", content: '      action: "git.push",' },
    { newLine: 8, kind: "addition", content: '      workspaceId: "ws_local",' },
    { newLine: 9, kind: "addition", content: "    });" },
    { newLine: 10, kind: "addition", content: "" },
    { newLine: 11, kind: "addition", content: '    expect(decision.effect).toBe("approval");' },
    { newLine: 12, kind: "addition", content: "    expect(decision.actionDigest).toHaveLength(64);" },
    { newLine: 13, kind: "addition", content: "  });" },
    { newLine: 14, kind: "addition", content: "});" },
  ],
};

const TERMINAL_LINES = [
  { type: "muted", text: "$ npm test -- --runInBand" },
  { type: "muted", text: "" },
  { type: "info", text: " RUN  v2.1.5  /workspace/acme-relay" },
  { type: "success", text: " ✓ tests/context.test.ts       (4 tests)  31ms" },
  { type: "success", text: " ✓ tests/policy.test.ts        (5 tests)  46ms" },
  { type: "pending", text: " ◌ tests/approval.test.ts      awaiting approval" },
  { type: "muted", text: "" },
  { type: "summary", text: " Test Files  2 passed | 1 pending" },
  { type: "summary", text: "      Tests  9 passed | 3 pending" },
];

const SOURCE_ITEMS = [
  { label: "workspace-agent.ts", detail: "lines 1–21", score: "98%" },
  { label: "policy.ts", detail: "lines 7–17", score: "94%" },
  { label: "approval.test.ts", detail: "new file", score: "91%" },
  { label: "SECURITY.md", detail: "approval model", score: "87%" },
];

function nowTime() {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function eventStateFromApi(value: unknown): EventState {
  return value === "complete" ||
    value === "active" ||
    value === "waiting" ||
    value === "queued"
    ? value
    : "complete";
}

export default function WorkspaceClient() {
  const [workspace, setWorkspace] = useState(INITIAL_WORKSPACE);
  const [apiState, setApiState] = useState<ApiState>("connecting");
  const [viewMode, setViewMode] = useState<ViewMode>("diff");
  const [bottomPanel, setBottomPanel] = useState<BottomPanel>("terminal");
  const [activeFile, setActiveFile] = useState("src/agent/workspace-agent.ts");
  const [folders, setFolders] = useState(() => new Set(["src", "agent", "policy", "tests"]));
  const [timeline, setTimeline] = useState(INITIAL_TIMELINE);
  const [approval, setApproval] = useState<ApprovalState>("pending");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [terminalLines, setTerminalLines] = useState(TERMINAL_LINES);
  const [acceptedFiles, setAcceptedFiles] = useState(() => new Set([
    "src/agent/workspace-agent.ts",
    "src/policy/policy.ts",
    "tests/approval.test.ts",
  ]));

  useEffect(() => {
    const controller = new AbortController();

    async function loadWorkspace() {
      try {
        const response = await fetch("/api/workspace", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Workspace unavailable");

        const data = (await response.json()) as WorkspaceApiResponse;
        const remote = data.workspace ?? {};
        const primaryTask = data.tasks?.[0];
        setWorkspace((current) => ({
          name: remote.name || current.name,
          repository: typeof remote.repository === "string"
            ? remote.repository
            : remote.repository?.name || remote.repo || current.repository,
          branch: remote.branch || current.branch,
          baseBranch: remote.baseBranch || current.baseBranch,
          taskId: remote.taskId || primaryTask?.id || current.taskId,
          taskTitle: remote.taskTitle || primaryTask?.title || current.taskTitle,
        }));

        if (data.events?.length) {
          const apiEvents = data.events.slice(-8).map((event, index) => ({
            id: event.id || `remote-event-${index}`,
            title: event.title || "Workspace event",
            detail: event.detail || "Recorded by the orchestrator",
            time: event.createdAt
              ? new Date(event.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })
              : "now",
            state: eventStateFromApi(event.state),
          }));
          setTimeline(apiEvents);
        }

        const remoteApproval = data.approvals?.find((item) => item.status === "pending");
        if (!remoteApproval && data.approvals?.length) {
          const latest = data.approvals[0]?.status;
          if (latest === "approved" || latest === "denied") setApproval(latest);
        }
        setApiState("connected");
      } catch (error) {
        if ((error as Error).name !== "AbortError") setApiState("preview");
      }
    }

    void loadWorkspace();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    function closePanels(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setExplorerOpen(false);
        setInspectorOpen(false);
      }
    }
    window.addEventListener("keydown", closePanels);
    return () => window.removeEventListener("keydown", closePanels);
  }, []);

  const currentDiff = useMemo(
    () => DIFF_CONTENT[activeFile] ?? DIFF_CONTENT["src/agent/workspace-agent.ts"],
    [activeFile],
  );
  const currentCode = useMemo(
    () => FILE_CONTENT[activeFile] ?? FILE_CONTENT["src/agent/workspace-agent.ts"],
    [activeFile],
  );

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3200);
  }

  function toggleFolder(folder: string) {
    setFolders((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  function selectFile(path: string) {
    setActiveFile(path);
    setExplorerOpen(false);
  }

  function toggleAcceptedFile(path: string) {
    setAcceptedFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function postWorkspaceAction(
    action: "create_task" | "approve" | "reject" | "cancel" | "resume",
    payload: Record<string, unknown> = {},
  ) {
    setBusyAction(action);
    const idempotencyKey = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    try {
      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, idempotencyKey, ...payload }),
      });
      if (!response.ok) throw new Error("Action unavailable");
      setApiState("connected");
    } catch {
      setApiState("preview");
    } finally {
      setBusyAction(null);
    }
  }

  async function resolveApproval(decision: "approve" | "deny") {
    const nextState: ApprovalState = decision === "approve" ? "approved" : "denied";
    setApproval(nextState);
    setTimeline((current) =>
      current.map((event) =>
        event.id === "event-4"
          ? {
              ...event,
              title: decision === "approve" ? "Execution approved" : "Execution denied",
              detail:
                decision === "approve"
                  ? "Single-use capability issued for the test runner"
                  : "No command was executed",
              time: nowTime(),
              state: "complete",
            }
          : event.id === "event-5" && decision === "approve"
            ? { ...event, state: "active", detail: "Test runner started in sandbox" }
            : event,
      ),
    );

    if (decision === "approve") {
      setTerminalLines((lines) => [
        ...lines.filter((line) => !line.text.includes("awaiting approval")),
        { type: "success", text: " ✓ tests/approval.test.ts      (3 tests)  28ms" },
        { type: "muted", text: "" },
        { type: "complete", text: " Test Files  3 passed (3)  ·  105ms" },
      ]);
      showNotice("Approved once · test runner capability expires in 5 minutes");
    } else {
      showNotice("Request denied · no command was executed");
    }

    await postWorkspaceAction(decision === "approve" ? "approve" : "reject", {
      approvalId: "approval_apply_session_patch",
    });
  }

  async function runChecks() {
    setBottomPanel("terminal");
    showNotice("Validation is a proposed R1 action and requires a fresh approval request");
  }

  async function createCommit() {
    showNotice(`${acceptedFiles.size} reviewed files selected · commit remains human-gated`);
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = prompt.trim();
    if (!message || busyAction) return;

    setPrompt("");
    setBusyAction("agent");
    setTimeline((current) => [
      ...current.slice(-6).map((item) => ({
        ...item,
        state: item.state === "active" ? "complete" as const : item.state,
      })),
      {
        id: `event-${Date.now()}`,
        title: "Follow-up received",
        detail: message,
        time: nowTime(),
        state: "active",
      },
    ]);

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          taskId: workspace.taskId,
          idempotencyKey: `agent-${Date.now()}`,
        }),
      });
      if (!response.ok) throw new Error("Agent unavailable");
      setApiState("connected");
      showNotice("Conductor is working on your follow-up");
    } catch {
      setApiState("preview");
      showNotice("Follow-up added to the local task timeline");
    } finally {
      setBusyAction(null);
    }
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const fileLabel = activeFile.split("/").at(-1) ?? activeFile;
  const apiLabel =
    apiState === "connected"
      ? "Orchestrator online"
      : apiState === "connecting"
        ? "Connecting"
        : "Local preview";

  return (
    <div className="conductor" data-testid="conductor-workspace">
      <header className="topbar">
        <div className="topbar-leading">
          <button
            className="icon-button mobile-only"
            type="button"
            aria-label="Toggle file explorer"
            aria-expanded={explorerOpen}
            onClick={() => setExplorerOpen((open) => !open)}
            data-testid="explorer-toggle"
          >
            ☰
          </button>
          <div className="brand-mark" aria-hidden="true">C</div>
          <span className="brand-name">Conductor</span>
          <span className="topbar-rule" aria-hidden="true" />
          <div className="repository-crumb" aria-label="Current repository">
            <span className="repo-owner">acme</span>
            <span className="crumb-slash">/</span>
            <strong>{workspace.repository.split("/").at(-1)}</strong>
          </div>
          <button className="branch-pill" type="button" aria-label={`Current branch ${workspace.branch}`}>
            <span aria-hidden="true">⑂</span>
            {workspace.branch.replace("agent/", "")}
          </button>
        </div>

        <div className="task-breadcrumb" aria-label="Active task">
          <span className="task-id">{workspace.taskId}</span>
          <span className="task-name">{workspace.taskTitle}</span>
        </div>

        <div className="topbar-actions">
          <span className={`connection-state ${apiState}`} title={apiLabel}>
            <span className="connection-dot" aria-hidden="true" />
            {apiLabel}
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="Open context inspector"
            aria-expanded={inspectorOpen}
            onClick={() => setInspectorOpen((open) => !open)}
            data-testid="inspector-toggle"
          >
            ◫
          </button>
          <button className="avatar-button" type="button" aria-label="Open account menu">TB</button>
        </div>
      </header>

      <div className="conductor-body">
        {(explorerOpen || inspectorOpen) && (
          <button
            className="panel-backdrop"
            type="button"
            aria-label="Close side panel"
            onClick={() => {
              setExplorerOpen(false);
              setInspectorOpen(false);
            }}
          />
        )}

        <aside className={`explorer-panel ${explorerOpen ? "is-open" : ""}`} aria-label="File explorer">
          <div className="panel-title-row">
            <span className="eyebrow">Explorer</span>
            <div className="panel-actions">
              <button type="button" aria-label="Create file">＋</button>
              <button type="button" aria-label="Refresh files">↻</button>
              <button type="button" aria-label="More explorer actions">•••</button>
            </div>
          </div>

          <button className="repo-heading" type="button" onClick={() => toggleFolder("root")}>
            <span className="tree-chevron open" aria-hidden="true">⌄</span>
            <strong>ACME-RELAY</strong>
            <span className="change-count">3</span>
          </button>

          <nav className="file-tree" aria-label="Repository files" data-testid="file-tree">
            <TreeFolder label="src" open={folders.has("src")} onToggle={() => toggleFolder("src")} />
            {folders.has("src") && (
              <div className="tree-children">
                <TreeFolder label="agent" open={folders.has("agent")} onToggle={() => toggleFolder("agent")} />
                {folders.has("agent") && (
                  <div className="tree-children">
                    <TreeFile
                      label="workspace-agent.ts"
                      path="src/agent/workspace-agent.ts"
                      status="M"
                      active={activeFile === "src/agent/workspace-agent.ts"}
                      onSelect={selectFile}
                    />
                    <TreeFile label="context.ts" path="src/agent/context.ts" active={false} onSelect={selectFile} />
                    <TreeFile label="types.ts" path="src/agent/types.ts" active={false} onSelect={selectFile} />
                  </div>
                )}
                <TreeFolder label="git" open={folders.has("git")} onToggle={() => toggleFolder("git")} />
                {folders.has("git") && (
                  <div className="tree-children">
                    <TreeFile label="operations.ts" path="src/git/operations.ts" active={false} onSelect={selectFile} />
                    <TreeFile label="provider.ts" path="src/git/provider.ts" active={false} onSelect={selectFile} />
                  </div>
                )}
                <TreeFolder label="policy" open={folders.has("policy")} onToggle={() => toggleFolder("policy")} />
                {folders.has("policy") && (
                  <div className="tree-children">
                    <TreeFile
                      label="policy.ts"
                      path="src/policy/policy.ts"
                      status="M"
                      active={activeFile === "src/policy/policy.ts"}
                      onSelect={selectFile}
                    />
                    <TreeFile label="types.ts" path="src/policy/types.ts" active={false} onSelect={selectFile} />
                  </div>
                )}
              </div>
            )}
            <TreeFolder label="tests" open={folders.has("tests")} onToggle={() => toggleFolder("tests")} />
            {folders.has("tests") && (
              <div className="tree-children">
                <TreeFile
                  label="approval.test.ts"
                  path="tests/approval.test.ts"
                  status="A"
                  active={activeFile === "tests/approval.test.ts"}
                  onSelect={selectFile}
                />
                <TreeFile label="context.test.ts" path="tests/context.test.ts" active={false} onSelect={selectFile} />
              </div>
            )}
            <TreeFile label=".env.example" path=".env.example" active={false} onSelect={selectFile} muted />
            <TreeFile label="package.json" path="package.json" active={false} onSelect={selectFile} />
            <TreeFile label="README.md" path="README.md" active={false} onSelect={selectFile} />
          </nav>

          <div className="explorer-spacer" />
          <section className="workspace-scope" aria-label="Workspace isolation status">
            <div className="scope-heading">
              <span className="scope-icon" aria-hidden="true">◇</span>
              <div>
                <strong>Task worktree</strong>
                <span>Isolated · non-root</span>
              </div>
            </div>
            <div className="scope-meter"><span /></div>
            <div className="scope-stats">
              <span>1.2 GB free</span>
              <span>expires 54m</span>
            </div>
          </section>
          <button className="explorer-footer" type="button">
            <span aria-hidden="true">⌘</span>
            <span>Command palette</span>
            <kbd>⌘ K</kbd>
          </button>
        </aside>

        <main className="workbench" aria-label="Code workspace">
          <section className="editor-panel" aria-label="Editor and diff viewer">
            <div className="editor-tabs-row">
              <div className="editor-tabs" role="tablist" aria-label="Open files">
                <EditorTab
                  label="workspace-agent.ts"
                  path="src/agent/workspace-agent.ts"
                  status="M"
                  active={activeFile === "src/agent/workspace-agent.ts"}
                  onSelect={selectFile}
                />
                <EditorTab
                  label="policy.ts"
                  path="src/policy/policy.ts"
                  status="M"
                  active={activeFile === "src/policy/policy.ts"}
                  onSelect={selectFile}
                />
                <EditorTab
                  label="approval.test.ts"
                  path="tests/approval.test.ts"
                  status="A"
                  active={activeFile === "tests/approval.test.ts"}
                  onSelect={selectFile}
                />
              </div>
              <div className="view-toggle" role="tablist" aria-label="Editor view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === "code"}
                  className={viewMode === "code" ? "active" : ""}
                  onClick={() => setViewMode("code")}
                  data-testid="code-view-tab"
                >
                  Code
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === "diff"}
                  className={viewMode === "diff" ? "active" : ""}
                  onClick={() => setViewMode("diff")}
                  data-testid="diff-view-tab"
                >
                  Diff <span className="tiny-count">3</span>
                </button>
              </div>
            </div>

            <div className="editor-toolbar">
              <div className="file-breadcrumb">
                {activeFile.split("/").map((part, index, parts) => (
                  <span key={`${part}-${index}`}>
                    {part}
                    {index < parts.length - 1 && <b aria-hidden="true">›</b>}
                  </span>
                ))}
              </div>
              <div className="diff-summary" aria-label="Diff summary">
                <span className="addition-text">+24</span>
                <span className="deletion-text">−6</span>
                <span className="reviewed-dot" aria-hidden="true" />
                reviewed
                <button type="button" aria-label="More editor actions">•••</button>
              </div>
            </div>

            <div className="code-surface" data-testid="code-workspace">
              {viewMode === "diff" ? (
                <div className="diff-view" role="table" aria-label={`Diff for ${fileLabel}`}>
                  {currentDiff.map((line, index) => (
                    <div className={`diff-line ${line.kind}`} role="row" key={`${index}-${line.content}`}>
                      <span className="line-number old" role="cell">{line.oldLine ?? ""}</span>
                      <span className="line-number new" role="cell">{line.newLine ?? ""}</span>
                      <span className="diff-marker" role="cell" aria-label={line.kind}>
                        {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : ""}
                      </span>
                      <code role="cell">{line.content || " "}</code>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="plain-code" role="table" aria-label={`Code for ${fileLabel}`}>
                  {currentCode.map((line, index) => (
                    <div className="code-line" role="row" key={`${index}-${line}`}>
                      <span className="line-number" role="cell">{index + 1}</span>
                      <code role="cell">{line || " "}</code>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="editor-statusbar">
              <span><b>Ln 16, Col 5</b></span>
              <span>Spaces: 2</span>
              <span>UTF-8</span>
              <span>TypeScript</span>
              <span className="status-spacer" />
              <span className="safe-status"><i aria-hidden="true">✓</i> policy checked</span>
            </div>
          </section>

          <section className="lower-panel" aria-label="Validation and Git review">
            <div className="lower-panel-tabs" role="tablist" aria-label="Bottom panel">
              <button
                type="button"
                role="tab"
                aria-selected={bottomPanel === "terminal"}
                className={bottomPanel === "terminal" ? "active" : ""}
                onClick={() => setBottomPanel("terminal")}
              >
                Terminal
              </button>
              <button type="button" role="tab" aria-selected="false">Problems <span>0</span></button>
              <button type="button" role="tab" aria-selected="false">Tests <span className="pass-count">9</span></button>
              <button
                type="button"
                role="tab"
                aria-selected={bottomPanel === "git"}
                className={bottomPanel === "git" ? "active" : ""}
                onClick={() => setBottomPanel("git")}
              >
                Git review <span>3</span>
              </button>
              <span className="lower-tabs-spacer" />
              <button type="button" aria-label="Clear terminal">Clear</button>
              <button type="button" aria-label="Maximize bottom panel">⌃</button>
            </div>

            <div className={`lower-content ${bottomPanel === "git" ? "git-focused" : ""}`}>
              <div className="terminal" data-testid="test-terminal" aria-label="Test terminal" aria-live="polite">
                <div className="terminal-command-row">
                  <span className="terminal-session">TASK TERMINAL</span>
                  <span className="terminal-sandbox"><i aria-hidden="true" /> sandbox · pid 418</span>
                </div>
                <div className="terminal-lines">
                  {terminalLines.map((line, index) => (
                    <div className={`terminal-line ${line.type}`} key={`${index}-${line.text}`}>{line.text || " "}</div>
                  ))}
                </div>
              </div>

              <aside className="git-review" aria-label="Git change review" data-testid="git-review">
                <div className="git-review-heading">
                  <div>
                    <span className="eyebrow">Ready to review</span>
                    <strong>{acceptedFiles.size} of 3 files</strong>
                  </div>
                  <div className="git-delta"><b>+48</b><span>−12</span></div>
                </div>
                <div className="review-files">
                  <ReviewFile
                    label="workspace-agent.ts"
                    path="src/agent/workspace-agent.ts"
                    delta="+18 −1"
                    checked={acceptedFiles.has("src/agent/workspace-agent.ts")}
                    onToggle={toggleAcceptedFile}
                  />
                  <ReviewFile
                    label="policy.ts"
                    path="src/policy/policy.ts"
                    delta="+16 −11"
                    checked={acceptedFiles.has("src/policy/policy.ts")}
                    onToggle={toggleAcceptedFile}
                  />
                  <ReviewFile
                    label="approval.test.ts"
                    path="tests/approval.test.ts"
                    delta="+14"
                    checked={acceptedFiles.has("tests/approval.test.ts")}
                    onToggle={toggleAcceptedFile}
                  />
                </div>
                <button
                  className="commit-button"
                  type="button"
                  onClick={() => void createCommit()}
                  disabled={acceptedFiles.size === 0 || busyAction === "create_commit"}
                  data-testid="create-commit-button"
                >
                  {busyAction === "create_commit" ? "Preparing…" : "Create reviewed commit"}
                  <span aria-hidden="true">→</span>
                </button>
              </aside>
            </div>
          </section>

          <form className="task-composer" onSubmit={submitTask} data-testid="task-prompt">
            <div className="composer-leading" aria-hidden="true">
              <span className="agent-orb"><i /></span>
            </div>
            <div className="composer-body">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={handlePromptKeyDown}
                placeholder="Ask Conductor to inspect, change, or verify this workspace…"
                aria-label="Task prompt"
                rows={2}
              />
              <div className="composer-options">
                <button type="button"><span className="mode-dot" /> Plan & execute <b aria-hidden="true">⌄</b></button>
                <button type="button">GPT-5 · Coding <b aria-hidden="true">⌄</b></button>
                <span className="composer-context">12 sources · 29% context</span>
                <span className="composer-spacer" />
                <span className="send-hint"><kbd>⌘</kbd><kbd>↵</kbd></span>
                <button
                  className="send-button"
                  type="submit"
                  aria-label="Send task to Conductor"
                  disabled={!prompt.trim() || busyAction !== null}
                  data-testid="send-task-button"
                >
                  {busyAction === "agent" ? "…" : "↑"}
                </button>
              </div>
            </div>
          </form>
        </main>

        <aside className={`inspector-panel ${inspectorOpen ? "is-open" : ""}`} aria-label="Task and context inspector">
          <div className="run-header">
            <div>
              <span className="eyebrow">Active run</span>
              <div className="run-title-row">
                <strong>Policy guardrails</strong>
                <span className="run-live"><i aria-hidden="true" /> waiting</span>
              </div>
            </div>
            <button type="button" aria-label="More run actions">•••</button>
          </div>

          <div className="run-progress" aria-label="Task progress: 3 of 5 steps">
            <span className="done" /><span className="done" /><span className="active" /><span /><span />
          </div>

          <section className={`approval-card ${approval}`} aria-labelledby="approval-title" data-testid="approval-card">
            <div className="approval-heading">
              <span className="approval-icon" aria-hidden="true">
                {approval === "approved" ? "✓" : approval === "denied" ? "×" : "!"}
              </span>
              <div>
                <span className="eyebrow">{approval === "pending" ? "Your approval" : "Decision recorded"}</span>
                <h2 id="approval-title">
                  {approval === "pending"
                    ? "Run repository tests?"
                    : approval === "approved"
                      ? "Approved once"
                      : "Execution denied"}
                </h2>
              </div>
              <span className="risk-pill">R1 · local</span>
            </div>

            <p>
              {approval === "pending"
                ? "The agent wants to execute a bounded command inside this task’s isolated worktree."
                : approval === "approved"
                  ? "A single-use capability was issued. It cannot be reused for a changed command or snapshot."
                  : "No capability was issued and the command did not run."}
            </p>

            <div className="command-preview">
              <span aria-hidden="true">$</span>
              <code>npm test -- --runInBand</code>
              <button type="button" aria-label="Copy command">Copy</button>
            </div>

            <dl className="approval-facts">
              <div><dt>Scope</dt><dd>/workspace/acme-relay</dd></div>
              <div><dt>Network</dt><dd>Blocked</dd></div>
              <div><dt>Expires</dt><dd>5 minutes</dd></div>
            </dl>

            {approval === "pending" ? (
              <div className="approval-actions">
                <button
                  className="deny-button"
                  type="button"
                  onClick={() => void resolveApproval("deny")}
                  disabled={busyAction !== null}
                  data-testid="deny-approval-button"
                >
                  Deny
                </button>
                <button
                  className="approve-button"
                  type="button"
                  onClick={() => void resolveApproval("approve")}
                  disabled={busyAction !== null}
                  data-testid="approve-once-button"
                >
                  {busyAction === "approve" ? "Approving…" : "Approve once"}
                  <span aria-hidden="true">→</span>
                </button>
              </div>
            ) : (
              <button className="reset-approval" type="button" onClick={() => setApproval("pending")}>
                Review request again
              </button>
            )}
          </section>

          <section className="inspector-section timeline-section" aria-labelledby="timeline-title" data-testid="agent-timeline">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Agent activity</span>
                <h2 id="timeline-title">Run timeline</h2>
              </div>
              <span className="elapsed">1m 26s</span>
            </div>
            <ol className="timeline-list">
              {timeline.map((event) => (
                <li className={event.state} key={event.id}>
                  <span className="timeline-node" aria-hidden="true">
                    {event.state === "complete" ? "✓" : event.state === "active" ? "" : "·"}
                  </span>
                  <div>
                    <div className="timeline-title-line">
                      <strong>{event.title}</strong>
                      <time>{event.time}</time>
                    </div>
                    <p>{event.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="inspector-section context-section" aria-labelledby="context-title" data-testid="context-inspector">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Grounding</span>
                <h2 id="context-title">Context inspector</h2>
              </div>
              <button type="button" aria-label="Refresh context">↻</button>
            </div>

            <div className="token-card">
              <div className="token-copy">
                <strong>6,842</strong>
                <span>of 24k input tokens</span>
                <b>29%</b>
              </div>
              <div className="token-meter"><span /></div>
              <div className="token-legend">
                <span><i className="policy-color" /> policy</span>
                <span><i className="source-color" /> sources</span>
                <span><i className="memory-color" /> memory</span>
              </div>
            </div>

            <div className="source-heading">
              <span>Included sources</span>
              <button type="button">View manifest</button>
            </div>
            <ul className="source-list">
              {SOURCE_ITEMS.map((source, index) => (
                <li key={source.label}>
                  <span className="source-file-icon">{index === 3 ? "MD" : "TS"}</span>
                  <div><strong>{source.label}</strong><span>{source.detail}</span></div>
                  <b>{source.score}</b>
                </li>
              ))}
            </ul>
            <div className="snapshot-row">
              <span><i aria-hidden="true" /> snapshot</span>
              <code>8f2c1d7</code>
              <b>fresh</b>
            </div>
          </section>

          <div className="inspector-footer">
            <button
              className="secondary-action"
              type="button"
              onClick={() => void runChecks()}
              disabled={busyAction === "run_checks"}
              data-testid="run-checks-button"
            >
              {busyAction === "run_checks" ? "Queueing…" : "Run checks"}
            </button>
            <button className="stop-action" type="button" onClick={() => void postWorkspaceAction("cancel", { taskId: workspace.taskId })}>
              Stop run
            </button>
          </div>
        </aside>
      </div>

      {notice && <div className="notice-toast" role="status">✓ <span>{notice}</span></div>}
    </div>
  );
}

function TreeFolder({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button className="tree-row folder-row" type="button" onClick={onToggle} aria-expanded={open}>
      <span className={`tree-chevron ${open ? "open" : ""}`} aria-hidden="true">›</span>
      <span className="folder-icon" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function TreeFile({
  label,
  path,
  status,
  active,
  onSelect,
  muted = false,
}: {
  label: string;
  path: string;
  status?: "M" | "A";
  active: boolean;
  onSelect: (path: string) => void;
  muted?: boolean;
}) {
  const extension = label.endsWith(".json") ? "{}" : label.endsWith(".md") ? "#" : label.endsWith(".env.example") ? "·" : "TS";
  return (
    <button
      className={`tree-row file-row ${active ? "active" : ""} ${muted ? "muted" : ""}`}
      type="button"
      onClick={() => onSelect(path)}
      aria-current={active ? "page" : undefined}
      data-path={path}
    >
      <span className={`file-icon ext-${extension.replace(/\W/g, "")}`} aria-hidden="true">{extension}</span>
      <span className="tree-file-label">{label}</span>
      {status && <span className={`file-status ${status === "A" ? "added" : ""}`}>{status}</span>}
    </button>
  );
}

function EditorTab({
  label,
  path,
  status,
  active,
  onSelect,
}: {
  label: string;
  path: string;
  status: "M" | "A";
  active: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <button
      className={`editor-tab ${active ? "active" : ""}`}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(path)}
    >
      <span className="tab-language">TS</span>
      <span>{label}</span>
      <i className={status === "A" ? "added" : ""}>{status}</i>
      <b aria-hidden="true">×</b>
    </button>
  );
}

function ReviewFile({
  label,
  path,
  delta,
  checked,
  onToggle,
}: {
  label: string;
  path: string;
  delta: string;
  checked: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <label className="review-file">
      <input type="checkbox" checked={checked} onChange={() => onToggle(path)} />
      <span className="review-checkbox" aria-hidden="true">{checked ? "✓" : ""}</span>
      <span className="review-filename">{label}</span>
      <span className="review-delta">{delta}</span>
    </label>
  );
}
