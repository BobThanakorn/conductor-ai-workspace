"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
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
  id: string;
  name: string;
  repository: string;
  repositoryPath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  headSha: string;
  network: string;
  runner: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  taskProgress: number;
  model: string;
};

type FileTreeNode = {
  id: string;
  name: string;
  type: "directory" | "file";
  status?: string;
  children?: FileTreeNode[];
};

type WorkspaceDiff = {
  file: string;
  status?: string;
  additions: number;
  deletions: number;
  checks: string[];
  baseSha?: string;
  headSha?: string;
  hunks: Array<{
    header: string;
    lines: Array<{
      type: "context" | "added" | "removed";
      oldNumber: number | null;
      newNumber: number | null;
      content: string;
    }>;
  }>;
};

type WorkspaceContext = {
  strategy: string;
  indexedFiles: number;
  indexedSymbols: number;
  snapshot: string;
  tokenBudget: { used: number; limit: number };
  sources: string[];
  freshness: string;
};

type WorkspaceApproval = {
  id: string;
  taskId?: string;
  action: string;
  summary: string;
  riskLevel: string;
  status: string;
  details: Record<string, unknown>;
  actionDigest?: string;
  expiresAt?: string;
};

type WorkspaceApiResponse = {
  workspace?: {
    id?: string;
    name: string;
    repository?: string | {
      name?: string;
      path?: string;
      defaultBranch?: string;
      activeBranch?: string;
      baseSha?: string;
      headSha?: string;
    };
    repo?: string;
    branch?: string;
    baseBranch?: string;
    taskId?: string;
    taskTitle?: string;
    environment?: { runner?: string; network?: string };
  };
  activeTask?: Partial<{
    id: string;
    title: string;
    goal: string;
    status: string;
    progress: number;
    model: string;
    branch: string;
  }> | null;
  tasks?: Array<Partial<{
    id: string;
    title: string;
    status: string;
    progress: number;
    model: string;
    branch: string;
  }>>;
  approvals?: WorkspaceApproval[];
  pendingApprovals?: WorkspaceApproval[];
  events?: Array<
    Partial<{
      sequence: number;
      id: string;
      title: string;
      detail: string;
      summary: string;
      type: string;
      createdAt: string;
      state: EventState;
    }>
  >;
  fileTree?: FileTreeNode[];
  diff?: WorkspaceDiff;
  context?: WorkspaceContext;
  eventStream?: { endpoint?: string; afterSequence?: number };
};

const INITIAL_WORKSPACE: WorkspaceMeta = {
  id: "workspace_atlas",
  name: "Atlas Engineering",
  repository: "openframe/atlas-web",
  repositoryPath: "/workspace/atlas-web",
  branch: "agent/harden-session-validation",
  baseBranch: "main",
  baseSha: "9f3a1c79d4b2",
  headSha: "c6a174b5a1f3",
  network: "Blocked",
  runner: "Cloudflare isolated workspace",
  taskId: "task_harden_sessions",
  taskTitle: "Harden session validation",
  taskStatus: "waiting_for_approval",
  taskProgress: 64,
  model: "gpt-5.3-codex",
};

const INITIAL_FILE_TREE: FileTreeNode[] = [
  {
    id: "src",
    name: "src",
    type: "directory",
    children: [
      {
        id: "src/agent",
        name: "agent",
        type: "directory",
        children: [
          { id: "src/agent/workspace-agent.ts", name: "workspace-agent.ts", type: "file", status: "modified" },
          { id: "src/agent/context.ts", name: "context.ts", type: "file" },
          { id: "src/agent/types.ts", name: "types.ts", type: "file" },
        ],
      },
      {
        id: "src/policy",
        name: "policy",
        type: "directory",
        children: [
          { id: "src/policy/policy.ts", name: "policy.ts", type: "file", status: "modified" },
          { id: "src/policy/types.ts", name: "types.ts", type: "file" },
        ],
      },
    ],
  },
  {
    id: "tests",
    name: "tests",
    type: "directory",
    children: [
      { id: "tests/approval.test.ts", name: "approval.test.ts", type: "file", status: "added" },
      { id: "tests/context.test.ts", name: "context.test.ts", type: "file" },
    ],
  },
  { id: "package.json", name: "package.json", type: "file" },
  { id: "README.md", name: "README.md", type: "file" },
];

const INITIAL_CONTEXT: WorkspaceContext = {
  strategy: "hybrid lexical + semantic + symbol graph",
  indexedFiles: 1842,
  indexedSymbols: 12744,
  snapshot: "8f2c1d7",
  tokenBudget: { used: 6842, limit: 24000 },
  sources: ["src/agent/workspace-agent.ts", "src/policy/policy.ts", "tests/approval.test.ts", "SECURITY.md"],
  freshness: "current worktree snapshot",
};

const INITIAL_APPROVAL: WorkspaceApproval = {
  id: "approval-test-suite-01",
  taskId: "task_harden_sessions",
  action: "run_tests",
  summary: "Run the repository test suite in the isolated task worktree.",
  riskLevel: "R1",
  status: "pending",
  details: { command: "npm test -- --runInBand", reversible: true },
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
  { type: "muted", text: "$ validation evidence summary" },
  { type: "muted", text: "" },
  { type: "info", text: " EVIDENCE  workspace snapshot attached to this task" },
  { type: "success", text: " ✓ unit tests                 24 passed (reported evidence)" },
  { type: "success", text: " ✓ TypeScript                 passed (reported evidence)" },
  { type: "pending", text: " ◌ local command execution    companion not connected" },
  { type: "muted", text: "" },
  { type: "summary", text: " No local, Git, network, or provider action was executed by this UI." },
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

function collectDirectories(nodes: FileTreeNode[], target = new Set<string>()) {
  for (const node of nodes) {
    if (node.type === "directory") {
      target.add(node.id);
      if (node.children) collectDirectories(node.children, target);
    }
  }
  return target;
}

function collectChangedFiles(nodes: FileTreeNode[], target: FileTreeNode[] = []) {
  for (const node of nodes) {
    if (node.type === "directory") collectChangedFiles(node.children ?? [], target);
    else if (node.status && node.status !== "unchanged") target.push(node);
  }
  return target;
}

function apiDiffLines(diff: WorkspaceDiff): DiffLine[] {
  return diff.hunks.flatMap((hunk) => [
    { kind: "fold" as const, content: hunk.header },
    ...hunk.lines.map((line) => ({
      oldLine: line.oldNumber ?? undefined,
      newLine: line.newNumber ?? undefined,
      kind: line.type === "added"
        ? "addition" as const
        : line.type === "removed"
          ? "deletion" as const
          : "context" as const,
      content: line.content,
    })),
  ]);
}

function sourceLabel(path: string, index: number) {
  const parts = path.split("/");
  return {
    label: parts.at(-1) ?? path,
    detail: parts.length > 1 ? parts.slice(0, -1).join("/") : "repository root",
    score: `${Math.max(78, 98 - index * 4)}%`,
  };
}

export default function WorkspaceClient() {
  const [workspace, setWorkspace] = useState(INITIAL_WORKSPACE);
  const [apiState, setApiState] = useState<ApiState>("connecting");
  const [viewMode, setViewMode] = useState<ViewMode>("diff");
  const [bottomPanel, setBottomPanel] = useState<BottomPanel>("terminal");
  const [activeFile, setActiveFile] = useState("src/agent/workspace-agent.ts");
  const [fileTree, setFileTree] = useState<FileTreeNode[]>(INITIAL_FILE_TREE);
  const [serverDiff, setServerDiff] = useState<WorkspaceDiff | null>(null);
  const [context, setContext] = useState<WorkspaceContext>(INITIAL_CONTEXT);
  const [activeApproval, setActiveApproval] = useState<WorkspaceApproval | null>(INITIAL_APPROVAL);
  const [folders, setFolders] = useState(() => collectDirectories(INITIAL_FILE_TREE));
  const [timeline, setTimeline] = useState(INITIAL_TIMELINE);
  const [approval, setApproval] = useState<ApprovalState>("pending");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [terminalLines, setTerminalLines] = useState(TERMINAL_LINES);
  const [acceptedFiles, setAcceptedFiles] = useState(() =>
    new Set(collectChangedFiles(INITIAL_FILE_TREE).map((file) => file.id)),
  );

  const loadWorkspace = useCallback(async (silent = false, signal?: AbortSignal) => {
    if (!silent) setApiState("connecting");
    try {
      const response = await fetch("/api/workspace", { cache: "no-store", signal });
      if (!response.ok) throw new Error("Workspace unavailable");

      const data = (await response.json()) as WorkspaceApiResponse;
      const remote = data.workspace;
      const repository = remote && typeof remote.repository === "object"
        ? remote.repository
        : undefined;
      const primaryTask = data.activeTask ?? data.tasks?.[0];

      setWorkspace((current) => ({
        id: remote?.id || current.id,
        name: remote?.name || current.name,
        repository: typeof remote?.repository === "string"
          ? remote.repository
          : repository?.name || remote?.repo || current.repository,
        repositoryPath: repository?.path || current.repositoryPath,
        branch: primaryTask?.branch || repository?.activeBranch || remote?.branch || current.branch,
        baseBranch: repository?.defaultBranch || remote?.baseBranch || current.baseBranch,
        baseSha: repository?.baseSha || current.baseSha,
        headSha: repository?.headSha || current.headSha,
        network: remote?.environment?.network || current.network,
        runner: remote?.environment?.runner || current.runner,
        taskId: primaryTask?.id || remote?.taskId || current.taskId,
        taskTitle: primaryTask?.title || remote?.taskTitle || current.taskTitle,
        taskStatus: primaryTask?.status || current.taskStatus,
        taskProgress: typeof primaryTask?.progress === "number" ? primaryTask.progress : current.taskProgress,
        model: primaryTask?.model || current.model,
      }));

      if (data.fileTree) {
        setFileTree(data.fileTree);
        setFolders(collectDirectories(data.fileTree));
        const changed = collectChangedFiles(data.fileTree);
        setAcceptedFiles(new Set(changed.map((file) => file.id)));
        const fileIds = new Set<string>();
        const visit = (nodes: FileTreeNode[]) => nodes.forEach((node) => {
          if (node.type === "file") fileIds.add(node.id);
          else visit(node.children ?? []);
        });
        visit(data.fileTree);
        setActiveFile((current) => fileIds.has(current) ? current : data.diff?.file || changed[0]?.id || current);
      }
      if (data.diff) setServerDiff(data.diff);
      if (data.context) setContext(data.context);

      if (data.approvals) {
        const remoteApproval = data.pendingApprovals?.[0] ?? data.approvals[0] ?? null;
        setActiveApproval(remoteApproval);
        if (remoteApproval) {
          setApproval(
            remoteApproval.status === "approved"
              ? "approved"
              : remoteApproval.status === "rejected" || remoteApproval.status === "denied"
                ? "denied"
                : "pending",
          );
        } else setApproval("approved");
      }

      if (data.events) {
        const apiEvents = [...data.events]
          .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
          .slice(-8)
          .map((event, index) => ({
            id: event.id || `remote-event-${index}`,
            title: event.title || event.type?.replaceAll(".", " ") || "Workspace event",
            detail: event.detail || event.summary || "Recorded by the orchestrator",
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

      setApiState("connected");
    } catch (error) {
      if ((error as Error).name !== "AbortError") setApiState("preview");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const initialLoad = window.setTimeout(() => {
      void loadWorkspace(false, controller.signal);
    }, 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadWorkspace(true, controller.signal);
      }
    }, 15_000);
    return () => {
      controller.abort();
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadWorkspace]);

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

  const currentDiff = useMemo(() => {
    if (serverDiff?.file === activeFile) return apiDiffLines(serverDiff);
    return DIFF_CONTENT[activeFile] ?? [{ kind: "fold", content: "No diff is available for this file." }];
  }, [activeFile, serverDiff]);
  const currentCode = useMemo(() => {
    if (serverDiff?.file === activeFile) {
      return serverDiff.hunks.flatMap((hunk) =>
        hunk.lines.filter((line) => line.type !== "removed").map((line) => line.content),
      );
    }
    return FILE_CONTENT[activeFile] ?? [
      `// ${activeFile}`,
      "",
      "// Source contents are not included in the current workspace snapshot.",
    ];
  }, [activeFile, serverDiff]);
  const changedFiles = useMemo(() => collectChangedFiles(fileTree), [fileTree]);
  const contextSources = useMemo(() => context.sources.map(sourceLabel), [context.sources]);
  const contextPercent = Math.min(100, Math.round((context.tokenBudget.used / Math.max(1, context.tokenBudget.limit)) * 100));
  const activeDiffStats = serverDiff?.file === activeFile
    ? { additions: serverDiff.additions, deletions: serverDiff.deletions }
    : { additions: 24, deletions: 6 };

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
      await loadWorkspace(true);
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
              title: decision === "approve" ? "Approval recorded" : "Execution denied",
              detail:
                decision === "approve"
                  ? "No command ran; a companion must submit a separately bound execution request"
                  : "No command was executed",
              time: nowTime(),
              state: "complete",
            }
          : event.id === "event-5" && decision === "approve"
            ? { ...event, state: "waiting", detail: "Awaiting a separately bound companion execution request" }
            : event,
      ),
    );

    if (decision === "approve") {
      setTerminalLines((lines) => [
        ...lines,
        { type: "pending", text: " ◌ approval recorded · no command was executed" },
      ]);
      showNotice("Approval recorded · no command ran from this workspace UI");
    } else {
      showNotice("Request denied · no command was executed");
    }

    await postWorkspaceAction(decision === "approve" ? "approve" : "reject", {
      approvalId: activeApproval?.id ?? "approval_apply_session_patch",
      workspaceId: workspace.id,
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
          workspaceId: workspace.id,
          idempotencyKey: `agent-${Date.now()}`,
        }),
      });
      if (!response.ok) throw new Error("Agent unavailable");
      setApiState("connected");
      await loadWorkspace(true);
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
  const approvalCommand = typeof activeApproval?.details.command === "string"
    ? activeApproval.details.command
    : activeApproval?.action === "apply_patch"
      ? `apply patch · ${Array.isArray(activeApproval.details.files) ? activeApproval.details.files.length : 0} files`
      : activeApproval?.action.replaceAll("_", " ") || "No action pending";
  const approvalExpiry = activeApproval?.expiresAt
    ? `at ${new Date(activeApproval.expiresAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : "5 minutes";

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
            <span className="repo-owner">{workspace.repository.split("/").slice(0, -1).join("/") || "local"}</span>
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
              <button type="button" aria-label="Refresh files" onClick={() => void loadWorkspace(true)}>↻</button>
              <button type="button" aria-label="More explorer actions">•••</button>
            </div>
          </div>

          <button className="repo-heading" type="button" onClick={() => toggleFolder("root")}>
            <span className="tree-chevron open" aria-hidden="true">⌄</span>
            <strong>{workspace.repository.split("/").at(-1)?.toUpperCase()}</strong>
            <span className="change-count">{changedFiles.length}</span>
          </button>

          <nav className="file-tree" aria-label="Repository files" data-testid="file-tree">
            {fileTree.map((node) => (
              <TreeNodeView
                key={node.id}
                node={node}
                folders={folders}
                activeFile={activeFile}
                onToggle={toggleFolder}
                onSelect={selectFile}
              />
            ))}
          </nav>

          <div className="explorer-spacer" />
          <section className="workspace-scope" aria-label="Workspace isolation status">
            <div className="scope-heading">
              <span className="scope-icon" aria-hidden="true">◇</span>
              <div>
                <strong>Task worktree</strong>
                <span>{workspace.runner}</span>
              </div>
            </div>
            <div className="scope-meter"><span /></div>
            <div className="scope-stats">
              <span>{workspace.network}</span>
              <span>task scoped</span>
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
                {(changedFiles.length ? changedFiles : [{ id: activeFile, name: fileLabel, type: "file" as const }])
                  .slice(0, 3)
                  .map((file) => (
                    <EditorTab
                      key={file.id}
                      label={file.name}
                      path={file.id}
                      status={file.status}
                      active={activeFile === file.id}
                      onSelect={selectFile}
                    />
                  ))}
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
                <span className="addition-text">+{activeDiffStats.additions}</span>
                <span className="deletion-text">−{activeDiffStats.deletions}</span>
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
                    <strong>{acceptedFiles.size} of {changedFiles.length} files</strong>
                  </div>
                  <div className="git-delta">
                    <b>+{serverDiff?.additions ?? 48}</b>
                    <span>−{serverDiff?.deletions ?? 12}</span>
                  </div>
                </div>
                <div className="review-files">
                  {changedFiles.map((file) => (
                    <ReviewFile
                      key={file.id}
                      label={file.name}
                      path={file.id}
                      delta={file.id === serverDiff?.file
                        ? `+${serverDiff.additions} −${serverDiff.deletions}`
                        : file.status === "added" ? "added" : "modified"}
                      checked={acceptedFiles.has(file.id)}
                      onToggle={toggleAcceptedFile}
                    />
                  ))}
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
                <button type="button">{workspace.model} <b aria-hidden="true">⌄</b></button>
                <span className="composer-context">{context.sources.length} sources · {contextPercent}% context</span>
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
                <strong>{workspace.taskTitle}</strong>
                <span className="run-live"><i aria-hidden="true" /> {workspace.taskStatus.replaceAll("_", " ")}</span>
              </div>
            </div>
            <button type="button" aria-label="More run actions">•••</button>
          </div>

          <div className="run-progress" aria-label={`Task progress: ${workspace.taskProgress}%`}>
            {Array.from({ length: 5 }, (_, index) => {
              const threshold = (index + 1) * 20;
              const className = workspace.taskProgress >= threshold
                ? "done"
                : workspace.taskProgress > index * 20
                  ? "active"
                  : "";
              return <span className={className} key={index} />;
            })}
          </div>

          <section className={`approval-card ${approval}`} aria-labelledby="approval-title" data-testid="approval-card">
            <div className="approval-heading">
              <span className="approval-icon" aria-hidden="true">
                {approval === "approved" ? "✓" : approval === "denied" ? "×" : "!"}
              </span>
              <div>
                <span className="eyebrow">
                  {!activeApproval ? "Policy status" : approval === "pending" ? "Your approval" : "Decision recorded"}
                </span>
                <h2 id="approval-title">
                  {!activeApproval
                    ? "No approval pending"
                    : approval === "pending"
                    ? activeApproval.action.replaceAll("_", " ")
                    : approval === "approved"
                      ? "Approval recorded"
                      : "Execution denied"}
                </h2>
              </div>
              <span className="risk-pill">{activeApproval?.riskLevel ?? "R0"} · local</span>
            </div>

            <p>
              {!activeApproval
                ? "The current run has no side-effecting action waiting for a human decision."
                : approval === "pending"
                ? activeApproval.summary
                : approval === "approved"
                  ? "Approval was recorded. No command has been executed; a separately bound companion request is still required."
                  : "No capability was issued and the command did not run."}
            </p>

            <div className="command-preview">
              <span aria-hidden="true">$</span>
              <code>{approvalCommand}</code>
              <button
                type="button"
                aria-label="Copy action preview"
                onClick={() => void navigator.clipboard?.writeText(approvalCommand)}
              >Copy</button>
            </div>

            <dl className="approval-facts">
              <div><dt>Scope</dt><dd>{workspace.repositoryPath}</dd></div>
              <div><dt>Network</dt><dd>{workspace.network}</dd></div>
              <div><dt>Expires</dt><dd>{approvalExpiry}</dd></div>
            </dl>

            {activeApproval && approval === "pending" ? (
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
              <button className="reset-approval" type="button" onClick={() => void loadWorkspace(true)}>
                Refresh policy state
              </button>
            )}
          </section>

          <section className="inspector-section timeline-section" aria-labelledby="timeline-title" data-testid="agent-timeline">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Agent activity</span>
                <h2 id="timeline-title">Run timeline</h2>
              </div>
              <span className="elapsed">{timeline.length} events</span>
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
              <button type="button" aria-label="Refresh context" onClick={() => void loadWorkspace(true)}>↻</button>
            </div>

            <div className="token-card">
              <div className="token-copy">
                <strong>{context.tokenBudget.used.toLocaleString()}</strong>
                <span>of {Math.round(context.tokenBudget.limit / 1000)}k input tokens</span>
                <b>{contextPercent}%</b>
              </div>
              <div className="token-meter"><span style={{ width: `${contextPercent}%` }} /></div>
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
              {contextSources.map((source) => (
                <li key={source.label}>
                  <span className="source-file-icon">{source.label.endsWith(".md") ? "MD" : source.label.split(".").at(-1)?.toUpperCase().slice(0, 2) || "F"}</span>
                  <div><strong>{source.label}</strong><span>{source.detail}</span></div>
                  <b>{source.score}</b>
                </li>
              ))}
            </ul>
            <div className="snapshot-row">
              <span><i aria-hidden="true" /> snapshot</span>
              <code>{context.snapshot}</code>
              <b>{context.freshness}</b>
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
            <button className="stop-action" type="button" onClick={() => void postWorkspaceAction("cancel", { taskId: workspace.taskId, workspaceId: workspace.id })}>
              Stop run
            </button>
          </div>
        </aside>
      </div>

      {notice && <div className="notice-toast" role="status">✓ <span>{notice}</span></div>}
    </div>
  );
}

function TreeNodeView({
  node,
  folders,
  activeFile,
  onToggle,
  onSelect,
}: {
  node: FileTreeNode;
  folders: Set<string>;
  activeFile: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  if (node.type === "file") {
    return (
      <TreeFile
        label={node.name}
        path={node.id}
        status={node.status}
        active={activeFile === node.id}
        onSelect={onSelect}
        muted={node.name.startsWith(".env")}
      />
    );
  }

  const open = folders.has(node.id);
  return (
    <>
      <TreeFolder label={node.name} open={open} onToggle={() => onToggle(node.id)} />
      {open && node.children?.length ? (
        <div className="tree-children">
          {node.children.map((child) => (
            <TreeNodeView
              key={child.id}
              node={child}
              folders={folders}
              activeFile={activeFile}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : null}
    </>
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
  status?: string;
  active: boolean;
  onSelect: (path: string) => void;
  muted?: boolean;
}) {
  const extension = label.endsWith(".json") ? "{}" : label.endsWith(".md") ? "#" : label.endsWith(".env.example") ? "·" : "TS";
  const shortStatus = status === "modified" ? "M" : status === "added" ? "A" : status?.slice(0, 1).toUpperCase();
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
      {shortStatus && <span className={`file-status ${shortStatus === "A" ? "added" : ""}`}>{shortStatus}</span>}
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
  status?: string;
  active: boolean;
  onSelect: (path: string) => void;
}) {
  const shortStatus = status === "modified" ? "M" : status === "added" ? "A" : status?.slice(0, 1).toUpperCase();
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
      {shortStatus && <i className={shortStatus === "A" ? "added" : ""}>{shortStatus}</i>}
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
