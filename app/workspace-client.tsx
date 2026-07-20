"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { runPythonSandbox } from "@/lib/python-runner";
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

type LocalGitFile = {
  code: string;
  path: string;
};

type LocalGitStatus = {
  ok?: boolean;
  root?: string;
  branch?: string;
  head?: string;
  files?: LocalGitFile[];
  raw?: string;
};

type LocalFsEntry = {
  path: string;
  name: string;
  type: "directory" | "file";
  children?: LocalFsEntry[];
};

type LocalGitCommit = {
  ok?: boolean;
  head?: string;
  stdout?: string;
  stderr?: string;
  error?: string;
};

type CompanionApproval = {
  ok?: boolean;
  approvalId?: string;
  digest?: string;
  token?: string;
  error?: string;
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

type GeneratedPythonFile = {
  path: string;
  content: string;
  language: string;
};

type PythonExecutionRequest = {
  entrypoint: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
};

type CodingAgentProposal = {
  summary: string;
  plan?: string[];
  proposedAction?: string;
  riskLevel?: "R0" | "R1" | "R2" | "R3";
  needsApproval?: boolean;
  evidence?: string[];
  artifacts?: GeneratedPythonFile[];
  execution?: PythonExecutionRequest;
};

type PythonExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs?: number;
};

type ApprovedPythonRun = {
  files: GeneratedPythonFile[];
  execution: PythonExecutionRequest;
};

type AgentApiResponse = {
  output?: CodingAgentProposal;
  model?: string;
  mode?: string;
  liveDiagnostic?: string;
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
  model: "gpt-5.1-codex-mini",
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

const LOCAL_GIT_COMPANION = "http://127.0.0.1:8765";

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

function normalizePythonFiles(value: unknown): GeneratedPythonFile[] {
  if (!Array.isArray(value) || value.length > 8) return [];
  const files = new Map<string, GeneratedPythonFile>();
  let totalBytes = 0;
  const validSegment = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    if (typeof record.language !== "string" || !record.language || typeof record.path !== "string" || typeof record.content !== "string") return [];
    const path = record.path.trim();
    const segments = path.split("/");
    if (
      path.length > 200 ||
      path.includes("\0") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      segments.some((segment) => !validSegment.test(segment) || segment === "." || segment === "..") ||
      files.has(path)
    ) return [];
    const contentBytes = new TextEncoder().encode(record.content).byteLength;
    if (contentBytes > 32_000) return [];
    totalBytes += contentBytes;
    if (totalBytes > 120_000) return [];
    files.set(path, { path, content: record.content, language: record.language.slice(0, 32) });
  }
  return Array.from(files.values());
}

function normalizePythonArgs(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) return null;
  let totalBytes = 0;
  let totalCharacters = 0;
  const args: string[] = [];
  for (const argument of value) {
    if (
      typeof argument !== "string" ||
      /[\u0000-\u001f\u007f]/.test(argument) ||
      argument.length > 256
    ) return null;
    totalCharacters += argument.length;
    if (totalCharacters > 2_048) return null;
    const bytes = new TextEncoder().encode(argument).byteLength;
    if (bytes > 4 * 1024) return null;
    totalBytes += bytes;
    if (totalBytes > 16 * 1024) return null;
    args.push(argument);
  }
  return args;
}

function mergeGeneratedTree(tree: FileTreeNode[], files: GeneratedPythonFile[]): FileTreeNode[] {
  if (!files.length) return tree;
  const localPaths = new Set(files.map((file) => file.path));
  const knownFiles = new Set<string>();
  const mergeNodes = (nodes: FileTreeNode[]): FileTreeNode[] => nodes.map((node) => {
    if (node.type === "file") {
      knownFiles.add(node.id);
      return localPaths.has(node.id) ? { ...node, status: "local" } : node;
    }
    return { ...node, children: mergeNodes(node.children ?? []) };
  });
  const mergedTree = mergeNodes(tree);
  const generated = files
    .filter((file) => !knownFiles.has(file.path))
    .map<FileTreeNode>((file) => ({
      id: file.path,
      name: file.path.split("/").at(-1) ?? file.path,
      type: "file",
      status: "local",
    }));
  if (!generated.length) return mergedTree;
  return [
    ...mergedTree,
    { id: "__generated_python__", name: "Generated files", type: "directory", children: generated },
  ];
}

function localGitTree(files: LocalGitFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const directories = new Map<string, FileTreeNode>();
  const ensureDirectory = (segments: string[]) => {
    let children = root;
    let currentPath = "";
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let directory = directories.get(currentPath);
      if (!directory) {
        directory = { id: currentPath, name: segment, type: "directory", children: [] };
        directories.set(currentPath, directory);
        children.push(directory);
      }
      children = directory.children ?? [];
    }
    return children;
  };

  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop() ?? file.path;
    const children = ensureDirectory(parts);
    const code = file.code.includes("?")
      ? "added"
      : file.code.includes("D")
        ? "deleted"
        : "modified";
    children.push({ id: file.path, name, type: "file", status: code });
  }
  return root.length ? root : INITIAL_FILE_TREE;
}

function localFsTree(entries: LocalFsEntry[], changed: LocalGitFile[]): FileTreeNode[] {
  const statuses = new Map(changed.map((file) => [file.path, file.code]));
  const convert = (entry: LocalFsEntry): FileTreeNode => {
    const code = statuses.get(entry.path) ?? "";
    const status = code.includes("?")
      ? "added"
      : code.includes("D")
        ? "deleted"
        : code.trim()
          ? "modified"
          : undefined;
    return {
      id: entry.path,
      name: entry.name,
      type: entry.type,
      ...(status ? { status } : {}),
      ...(entry.type === "directory" ? { children: (entry.children ?? []).map(convert) } : {}),
    };
  };
  return entries.map(convert);
}

function flattenFileTree(nodes: FileTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === "file" ? [node.id] : flattenFileTree(node.children ?? []));
}

function diffFromUnifiedText(file: string, text: string): WorkspaceDiff {
  const lines = text.split(/\r?\n/);
  const hunks: WorkspaceDiff["hunks"] = [];
  let current: WorkspaceDiff["hunks"][number] | null = null;
  let oldNumber = 0;
  let newNumber = 0;
  let additions = 0;
  let deletions = 0;
  const hunkPattern = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  for (const line of lines) {
    const hunkMatch = hunkPattern.exec(line);
    if (hunkMatch) {
      current = { header: line, lines: [] };
      hunks.push(current);
      oldNumber = Number(hunkMatch[1]);
      newNumber = Number(hunkMatch[2]);
      continue;
    }
    if (!current || line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
      current.lines.push({ type: "added", oldNumber: null, newNumber: newNumber++, content: line.slice(1) });
    } else if (line.startsWith("-")) {
      deletions += 1;
      current.lines.push({ type: "removed", oldNumber: oldNumber++, newNumber: null, content: line.slice(1) });
    } else {
      current.lines.push({ type: "context", oldNumber: oldNumber++, newNumber: newNumber++, content: line.startsWith(" ") ? line.slice(1) : line });
    }
  }

  return {
    file,
    status: "modified",
    additions,
    deletions,
    checks: ["local git companion"],
    hunks: hunks.length ? hunks : [{ header: "No diff output.", lines: [] }],
  };
}

function normalizeExecutionResult(value: unknown): PythonExecutionResult {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const runnerError = record.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : null;
  const errorMessage = typeof runnerError?.message === "string" ? runnerError.message : "";
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  return {
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: [stderr, errorMessage].filter(Boolean).join(stderr && errorMessage ? "\n" : ""),
    exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
    timedOut: record.timedOut === true,
    durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
  };
}

function executionTerminalLines(run: ApprovedPythonRun, result?: PythonExecutionResult) {
  const command = `$ python ${run.execution.entrypoint}${run.execution.args?.length ? ` ${run.execution.args.join(" ")}` : ""}`;
  if (!result) {
    return [
      { type: "muted", text: command },
      { type: "running", text: " ◌ Python sandbox is running…" },
    ];
  }
  const stdout = result.stdout.split(/\r?\n/).filter(Boolean).map((text) => ({ type: "output", text }));
  const stderr = result.stderr.split(/\r?\n/).filter(Boolean).map((text) => ({ type: "error", text }));
  const exitText = result.timedOut
    ? ` Process timed out${result.durationMs ? ` after ${result.durationMs}ms` : ""}`
    : ` Process exited with status ${result.exitCode ?? "unknown"}${result.durationMs ? ` · ${result.durationMs}ms` : ""}`;
  return [
    { type: "muted", text: command },
    ...stdout,
    ...stderr,
    { type: result.exitCode === 0 && !result.timedOut ? "complete" : "error", text: exitText },
  ];
}

export default function WorkspaceClient() {
  const agentModelOverride = useRef<string | null>(null);
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
  const [pendingProposal, setPendingProposal] = useState<CodingAgentProposal | null>(null);
  const [proposalOrigin, setProposalOrigin] = useState<{ mode: string; diagnostic?: string }>({ mode: "unknown" });
  const [localPythonFiles, setLocalPythonFiles] = useState<GeneratedPythonFile[]>([]);
  const [storageReady, setStorageReady] = useState(false);
  const [selectedGeneratedFile, setSelectedGeneratedFile] = useState<string | null>(null);
  const [approvedPythonRun, setApprovedPythonRun] = useState<ApprovedPythonRun | null>(null);
  const [executionResult, setExecutionResult] = useState<PythonExecutionResult | null>(null);
  const [executionState, setExecutionState] = useState<"idle" | "running" | "complete" | "failed">("idle");
  const [terminalCommand, setTerminalCommand] = useState("");
  const [repositoryFileContents, setRepositoryFileContents] = useState<Record<string, string>>({});
  const [localGitConnected, setLocalGitConnected] = useState(false);
  const [acceptedFiles, setAcceptedFiles] = useState(() =>
    new Set(collectChangedFiles(INITIAL_FILE_TREE).map((file) => file.id)),
  );

  const refreshLocalGit = useCallback(async (silent = true) => {
    try {
      const [response, treeResponse] = await Promise.all([
        fetch(`${LOCAL_GIT_COMPANION}/git/status`, { cache: "no-store" }),
        fetch(`${LOCAL_GIT_COMPANION}/fs/tree?depth=6`, { cache: "no-store" }),
      ]);
      if (!response.ok) throw new Error("Local Git companion unavailable");
      const data = (await response.json()) as LocalGitStatus;
      if (!data.ok) throw new Error("Local Git companion returned an error");
      const files = data.files ?? [];
      const treeData = treeResponse.ok
        ? await treeResponse.json() as { entries?: LocalFsEntry[] }
        : undefined;
      const nextTree = treeData?.entries?.length ? localFsTree(treeData.entries, files) : localGitTree(files);
      const nextChanged = collectChangedFiles(nextTree);
      setLocalGitConnected(true);
      setApiState("connected");
      setWorkspace((current) => ({
        ...current,
        repositoryPath: data.root || current.repositoryPath,
        branch: data.branch || current.branch,
        headSha: data.head || current.headSha,
        network: "Local companion",
        runner: "Local Git companion",
        taskStatus: files.length ? "ready_to_review" : "clean",
        taskProgress: files.length ? 82 : 100,
      }));
      setFileTree(nextTree);
      setFolders((current) => new Set([...collectDirectories(nextTree), ...current]));
      setAcceptedFiles(new Set(nextChanged.map((file) => file.id)));
      if (nextChanged[0]) {
        setActiveFile((current) => current.endsWith(".py") ? current : nextChanged[0].id);
        const diffResponse = await fetch(`${LOCAL_GIT_COMPANION}/git/diff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: [nextChanged[0].id] }),
        });
        if (diffResponse.ok) {
          const diffData = (await diffResponse.json()) as { stdout?: string };
          setServerDiff(diffFromUnifiedText(nextChanged[0].id, diffData.stdout ?? ""));
        }
      } else {
        setServerDiff(null);
      }
      setTerminalLines([
        { type: "muted", text: "$ git status --short" },
        ...(data.raw?.trim()
          ? data.raw.trimEnd().split(/\r?\n/).map((text) => ({ type: "output", text }))
          : [{ type: "success", text: " Working tree clean" }]),
        { type: "summary", text: " Local Git companion connected. Commit is available for selected reviewed files." },
      ]);
    } catch {
      setLocalGitConnected(false);
      if (!silent) {
        setTerminalLines((current) => [
          ...current.slice(-12),
          { type: "error", text: " Local Git companion is not running. Start it with: npm run companion:git" },
        ]);
      }
    }
  }, []);

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
        model: agentModelOverride.current || primaryTask?.model || current.model,
      }));

      const remoteFileTree = data.fileTree;
      if (remoteFileTree) {
        setFileTree(remoteFileTree);
        setFolders((current) => new Set([
          ...collectDirectories(remoteFileTree),
          ...(current.has("__generated_python__") ? ["__generated_python__"] : []),
        ]));
        const changed = collectChangedFiles(remoteFileTree);
        setAcceptedFiles((current) => new Set([
          ...changed.map((file) => file.id),
          ...Array.from(current).filter((path) => path.endsWith(".py")),
        ]));
        const fileIds = new Set<string>();
        const visit = (nodes: FileTreeNode[]) => nodes.forEach((node) => {
          if (node.type === "file") fileIds.add(node.id);
          else visit(node.children ?? []);
        });
        visit(remoteFileTree);
        setActiveFile((current) => current.endsWith(".py") || fileIds.has(current) ? current : data.diff?.file || changed[0]?.id || current);
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
      void refreshLocalGit(true);
    }, 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void loadWorkspace(true, controller.signal);
        void refreshLocalGit(true);
      }
    }, 15_000);
    return () => {
      controller.abort();
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadWorkspace, refreshLocalGit]);

  useEffect(() => {
    const hydrateStorage = window.setTimeout(() => {
      try {
        const stored = window.localStorage.getItem("conductor.generatedPythonFiles");
        const files = normalizePythonFiles(stored ? JSON.parse(stored) : []);
        setLocalPythonFiles(files);
        if (files.length) {
          setFolders((current) => new Set(current).add("__generated_python__"));
          setAcceptedFiles((current) => new Set([...current, ...files.map((file) => file.path)]));
        }
      } catch {
        window.localStorage.removeItem("conductor.generatedPythonFiles");
      } finally {
        setStorageReady(true);
      }
    }, 0);
    return () => window.clearTimeout(hydrateStorage);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    window.localStorage.setItem("conductor.generatedPythonFiles", JSON.stringify(localPythonFiles));
  }, [localPythonFiles, storageReady]);

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

  const draftPythonFiles = useMemo(
    () => normalizePythonFiles(pendingProposal?.artifacts),
    [pendingProposal],
  );
  const selectedDraftFile = useMemo(
    () => draftPythonFiles.find((file) => file.path === activeFile) ?? null,
    [activeFile, draftPythonFiles],
  );
  const selectedPythonFile = useMemo(
    () => localPythonFiles.find((file) => file.path === activeFile) ?? null,
    [activeFile, localPythonFiles],
  );
  const displayFileTree = useMemo(
    () => mergeGeneratedTree(fileTree, localPythonFiles),
    [fileTree, localPythonFiles],
  );
  const currentDiff = useMemo<DiffLine[]>(() => {
    if (selectedDraftFile) {
      const lines = selectedDraftFile.content.split(/\r?\n/);
      return [
        { kind: "fold" as const, content: `@@ draft · not applied · +1,${lines.length} @@` },
        ...lines.map((content, index) => ({ kind: "addition" as const, newLine: index + 1, content })),
      ];
    }
    if (selectedPythonFile) {
      const lines = selectedPythonFile.content.split(/\r?\n/);
      return [
        { kind: "fold" as const, content: `@@ -0,0 +1,${lines.length} @@ generated file` },
        ...lines.map((content, index) => ({ kind: "addition" as const, newLine: index + 1, content })),
      ];
    }
    if (serverDiff?.file === activeFile) return apiDiffLines(serverDiff);
    return DIFF_CONTENT[activeFile] ?? [{ kind: "fold", content: "No diff is available for this file." }];
  }, [activeFile, selectedDraftFile, selectedPythonFile, serverDiff]);
  const currentCode = useMemo(() => {
    if (selectedDraftFile) return selectedDraftFile.content.split(/\r?\n/);
    if (selectedPythonFile) return selectedPythonFile.content.split(/\r?\n/);
    if (repositoryFileContents[activeFile] !== undefined) {
      return repositoryFileContents[activeFile].split(/\r?\n/);
    }
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
  }, [activeFile, repositoryFileContents, selectedDraftFile, selectedPythonFile, serverDiff]);
  const changedFiles = useMemo(() => collectChangedFiles(displayFileTree), [displayFileTree]);
  const editorFiles = useMemo(() => {
    const activeVirtual: FileTreeNode | null = selectedDraftFile
      ? { id: selectedDraftFile.path, name: selectedDraftFile.path.split("/").at(-1) ?? selectedDraftFile.path, type: "file", status: "draft" }
      : selectedPythonFile
        ? { id: selectedPythonFile.path, name: selectedPythonFile.path.split("/").at(-1) ?? selectedPythonFile.path, type: "file", status: "local" }
        : null;
    const unique = new Map<string, FileTreeNode>();
    if (activeVirtual) unique.set(activeVirtual.id, activeVirtual);
    changedFiles.forEach((file) => unique.set(file.id, file));
    if (!unique.size) unique.set(activeFile, { id: activeFile, name: activeFile.split("/").at(-1) ?? activeFile, type: "file" });
    return Array.from(unique.values()).slice(0, 3);
  }, [activeFile, changedFiles, selectedDraftFile, selectedPythonFile]);
  const contextSources = useMemo(() => context.sources.map(sourceLabel), [context.sources]);
  const contextPercent = Math.min(100, Math.round((context.tokenBudget.used / Math.max(1, context.tokenBudget.limit)) * 100));
  const activeDiffStats = selectedDraftFile
    ? { additions: selectedDraftFile.content.split(/\r?\n/).length, deletions: 0 }
    : selectedPythonFile
    ? { additions: selectedPythonFile.content.split(/\r?\n/).length, deletions: 0 }
    : serverDiff?.file === activeFile
      ? { additions: serverDiff.additions, deletions: serverDiff.deletions }
      : { additions: 24, deletions: 6 };
  const requestedDraftEntrypoint = pendingProposal?.execution?.entrypoint
    ?.trim();
  const proposalEntrypoint = requestedDraftEntrypoint
    ? draftPythonFiles.some((file) => file.path === requestedDraftEntrypoint) ? requestedDraftEntrypoint : null
    : draftPythonFiles[0]?.path ?? null;
  const proposalArgs = normalizePythonArgs(pendingProposal?.execution?.args);
  const requestedTimeoutMs = pendingProposal?.execution?.timeoutMs;
  const proposalTimeoutMs = typeof requestedTimeoutMs === "number" && Number.isFinite(requestedTimeoutMs)
    ? Math.min(300_000, Math.max(100, Math.round(requestedTimeoutMs)))
    : 5_000;

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

  async function selectFile(path: string) {
    setActiveFile(path);
    setSelectedGeneratedFile(localPythonFiles.some((file) => file.path === path) ? path : null);
    setExplorerOpen(false);
    if (localGitConnected) {
      try {
        const [response, readResponse] = await Promise.all([
          fetch(`${LOCAL_GIT_COMPANION}/git/diff`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths: [path] }),
          }),
          fetch(`${LOCAL_GIT_COMPANION}/fs/read`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
          }),
        ]);
        if (readResponse.ok) {
          const data = await readResponse.json() as { content?: string };
          if (typeof data.content === "string") {
            setRepositoryFileContents((current) => ({ ...current, [path]: data.content as string }));
          }
        }
        if (response.ok) {
          const data = (await response.json()) as { stdout?: string };
          setServerDiff(diffFromUnifiedText(path, data.stdout ?? ""));
        }
      } catch {
        setLocalGitConnected(false);
      }
    }
  }

  async function collectRepositoryContext(message: string) {
    if (!localGitConnected) return localPythonFiles.map(({ path, content }) => ({ path, content }));
    const textExtensions = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|cs|cpp|c|h|hpp|rb|php|swift|sql|md|json|ya?ml|toml|ini|css|scss|html|sh|ps1)$/i;
    const normalizedMessage = message.toLowerCase();
    const changed = new Set(collectChangedFiles(fileTree).map((file) => file.id));
    const candidates = flattenFileTree(fileTree)
      .filter((path) => textExtensions.test(path))
      .map((path) => ({
        path,
        score:
          (path === activeFile ? 100 : 0) +
          (changed.has(path) ? 40 : 0) +
          (normalizedMessage.includes(path.toLowerCase()) ? 80 : 0) +
          (normalizedMessage.includes(path.split("/").at(-1)?.toLowerCase() ?? "") ? 30 : 0),
      }))
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, 8);
    const snapshots = await Promise.all(candidates.map(async ({ path }) => {
      try {
        const response = await fetch(`${LOCAL_GIT_COMPANION}/fs/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        if (!response.ok) return null;
        const data = await response.json() as { content?: string };
        if (typeof data.content !== "string" || !data.content) return null;
        return { path, content: data.content.slice(0, 32_000) };
      } catch {
        return null;
      }
    }));
    let total = 0;
    return snapshots.filter((snapshot): snapshot is { path: string; content: string } => {
      if (!snapshot) return false;
      const bytes = new TextEncoder().encode(snapshot.content).byteLength;
      if (total + bytes > 120_000) return false;
      total += bytes;
      return true;
    });
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

  async function getCompanionApproval(action: string, input: Record<string, unknown>) {
    const requestResponse = await fetch(`${LOCAL_GIT_COMPANION}/approvals/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, input }),
    });
    const requestData = (await requestResponse.json()) as CompanionApproval;
    if (!requestResponse.ok || !requestData.approvalId || !requestData.digest) {
      throw new Error(requestData.error || "The companion could not create an approval request.");
    }
    const approvalResponse = await fetch(`${LOCAL_GIT_COMPANION}/approvals/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approvalId: requestData.approvalId,
        digest: requestData.digest,
        confirm: true,
      }),
    });
    const approvalData = (await approvalResponse.json()) as CompanionApproval;
    if (!approvalResponse.ok || !approvalData.token) {
      throw new Error(approvalData.error || "The companion did not issue an approval token.");
    }
    return approvalData.token;
  }

  async function executeTerminalCommand() {
    const command = terminalCommand.trim();
    if (!command || busyAction) return;
    setBusyAction("terminal");
    setBottomPanel("terminal");
    const input = { command, cwd: ".", timeoutMs: 120_000 };
    setTerminalLines([{ type: "muted", text: `$ ${command}` }, { type: "running", text: " ◌ awaiting one-time approval and execution…" }]);
    try {
      const token = await getCompanionApproval("terminal.execute", input);
      const response = await fetch(`${LOCAL_GIT_COMPANION}/terminal/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Conductor-Approval": token },
        body: JSON.stringify(input),
      });
      const data = (await response.json()) as PythonExecutionResult & { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || "Command execution failed.");
      setTerminalLines([
        { type: "muted", text: `$ ${command}` },
        ...data.stdout.split(/\r?\n/).filter(Boolean).map((text) => ({ type: "output", text })),
        ...data.stderr.split(/\r?\n/).filter(Boolean).map((text) => ({ type: "error", text })),
        { type: data.exitCode === 0 ? "complete" : "error", text: ` Process exited with status ${data.exitCode ?? "unknown"} · ${data.durationMs ?? 0}ms` },
      ]);
      setTerminalCommand("");
      await refreshLocalGit(true);
    } catch (error) {
      setTerminalLines((current) => [...current.slice(0, 1), { type: "error", text: ` ${error instanceof Error ? error.message : "Command failed"}` }]);
    } finally {
      setBusyAction(null);
    }
  }

  async function createCommit() {
    if (!acceptedFiles.size) return;
    setBusyAction("create_commit");
    setBottomPanel("terminal");
    const paths = Array.from(acceptedFiles);
    if (!paths.length) {
      showNotice("Select at least one repository file first");
      setBusyAction(null);
      return;
    }
    try {
      const input = {
        paths,
        message: `chore: apply reviewed workspace changes`,
      };
      const token = await getCompanionApproval("git.commit", input);
      const response = await fetch(`${LOCAL_GIT_COMPANION}/git/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Conductor-Approval": token },
        body: JSON.stringify(input),
      });
      const data = (await response.json()) as LocalGitCommit;
      if (!response.ok || !data.ok) throw new Error(data.error || "Commit failed");
      setTerminalLines([
        { type: "muted", text: `$ git add -- ${paths.join(" ")}` },
        { type: "muted", text: '$ git commit -m "chore: apply reviewed workspace changes"' },
        ...(data.stdout?.trim()
          ? data.stdout.trimEnd().split(/\r?\n/).map((text) => ({ type: "output", text }))
          : []),
        ...(data.stderr?.trim()
          ? data.stderr.trimEnd().split(/\r?\n/).map((text) => ({ type: "error", text }))
          : []),
        { type: "success", text: ` Commit created: ${data.head ?? "new HEAD"}` },
      ]);
      setTimeline((current) => [
        ...current.slice(-7),
        {
          id: `git-commit-${Date.now()}`,
          title: "Reviewed commit created",
          detail: `${paths.length} file${paths.length === 1 ? "" : "s"} committed at ${data.head ?? "HEAD"}`,
          time: nowTime(),
          state: "complete",
        },
      ]);
      showNotice(`Commit created: ${data.head ?? "HEAD"}`);
      await refreshLocalGit(true);
    } catch (error) {
      setTerminalLines((current) => [
        ...current.slice(-12),
        { type: "error", text: ` Commit failed: ${error instanceof Error ? error.message : "local companion unavailable"}` },
        { type: "pending", text: " Start the bridge in this repo with: npm run companion:git" },
      ]);
      showNotice("Commit failed · local Git companion is not connected");
      setLocalGitConnected(false);
    } finally {
      setBusyAction(null);
    }
  }

  async function executePython(run: ApprovedPythonRun) {
    const runEventId = `python-run-${Date.now()}`;
    setBottomPanel("terminal");
    setExecutionState("running");
    setExecutionResult(null);
    setTerminalLines(executionTerminalLines(run));
    setTimeline((current) => [
      ...current.slice(-7),
      {
        id: runEventId,
        title: "Python sandbox running",
        detail: `Executing ${run.execution.entrypoint} with network and host filesystem access disabled`,
        time: nowTime(),
        state: "active",
      },
    ]);
    try {
      const rawResult = await runPythonSandbox({
        files: run.files.map(({ path, content }) => ({ path, content })),
        entrypoint: run.execution.entrypoint,
        args: run.execution.args ?? [],
        timeoutMs: run.execution.timeoutMs ?? 5_000,
      });
      const result = normalizeExecutionResult(rawResult);
      setExecutionResult(result);
      setExecutionState(result.exitCode === 0 && !result.timedOut ? "complete" : "failed");
      setTerminalLines(executionTerminalLines(run, result));
      setTimeline((current) => current.map((item) => item.id === runEventId
        ? {
            ...item,
            title: result.exitCode === 0 && !result.timedOut ? "Python run completed" : "Python run failed",
            detail: result.timedOut
              ? `Execution stopped after ${result.durationMs ?? run.execution.timeoutMs ?? 5_000} ms`
              : `Exit ${result.exitCode ?? "unknown"} · ${result.durationMs ?? 0} ms`,
            time: nowTime(),
            state: "complete",
          }
        : item));
      showNotice(result.exitCode === 0 && !result.timedOut ? "Python run completed" : "Python run finished with an error");
    } catch (error) {
      const result: PythonExecutionResult = {
        stdout: "",
        stderr: error instanceof Error ? error.message : "The Python sandbox could not start.",
        exitCode: null,
        timedOut: false,
      };
      setExecutionResult(result);
      setExecutionState("failed");
      setTerminalLines(executionTerminalLines(run, result));
      setTimeline((current) => current.map((item) => item.id === runEventId
        ? {
            ...item,
            title: "Python sandbox failed",
            detail: result.stderr,
            time: nowTime(),
            state: "complete",
          }
        : item));
      showNotice("Python sandbox failed to start");
    }
  }

  async function approvePythonProposal() {
    if (!pendingProposal) return;
    const files = normalizePythonFiles(pendingProposal.artifacts);
    if (!files.length) {
      showNotice("This proposal has no safe Python files to create");
      return;
    }
    if (!proposalEntrypoint) {
      showNotice("The proposed entrypoint is not one of the reviewed Python files");
      return;
    }
    const entrypoint = proposalEntrypoint;
    const execution: PythonExecutionRequest = {
      entrypoint,
      args: proposalArgs ?? [],
      timeoutMs: proposalTimeoutMs,
    };
    if (localGitConnected) {
      setExecutionState("running");
      setBottomPanel("terminal");
      try {
        const writeInput = { files: files.map(({ path, content }) => ({ path, content })) };
        const writeToken = await getCompanionApproval("fs.write", writeInput);
        const writeResponse = await fetch(`${LOCAL_GIT_COMPANION}/fs/write`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Conductor-Approval": writeToken },
          body: JSON.stringify(writeInput),
        });
        const writeData = (await writeResponse.json()) as { ok?: boolean; error?: string };
        if (!writeResponse.ok || !writeData.ok) throw new Error(writeData.error || "Writing repository files failed.");

        const quotedArgs = (execution.args ?? []).map((argument) => JSON.stringify(argument)).join(" ");
        const command = execution.command?.trim() || `python3 ${JSON.stringify(execution.entrypoint)}${quotedArgs ? ` ${quotedArgs}` : ""}`;
        const executeInput = { command, cwd: ".", timeoutMs: execution.timeoutMs ?? 5_000 };
        const executeToken = await getCompanionApproval("terminal.execute", executeInput);
        const executeResponse = await fetch(`${LOCAL_GIT_COMPANION}/terminal/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Conductor-Approval": executeToken },
          body: JSON.stringify(executeInput),
        });
        const result = (await executeResponse.json()) as PythonExecutionResult & { ok?: boolean; error?: string };
        if (!executeResponse.ok || !result.ok) throw new Error(result.error || "Python execution failed.");
        setExecutionResult(result);
        setExecutionState(result.exitCode === 0 ? "complete" : "failed");
        setTerminalLines([
          { type: "muted", text: `$ ${command}` },
          ...result.stdout.split(/\r?\n/).filter(Boolean).map((text) => ({ type: "output", text })),
          ...result.stderr.split(/\r?\n/).filter(Boolean).map((text) => ({ type: "error", text })),
          { type: result.exitCode === 0 ? "complete" : "error", text: ` Process exited with status ${result.exitCode ?? "unknown"} · ${result.durationMs ?? 0}ms` },
        ]);
        setPendingProposal(null);
        setInspectorOpen(false);
        await refreshLocalGit(true);
        showNotice(`${files.length} repository file${files.length === 1 ? "" : "s"} created and executed`);
        return;
      } catch (error) {
        setExecutionState("failed");
        setTerminalLines((current) => [...current.slice(-4), { type: "error", text: ` ${error instanceof Error ? error.message : "Repository execution failed"}` }]);
        showNotice("Repository execution failed; proposal remains available for review");
        return;
      }
    }

    if (files.some((file) => file.language !== "python" || !file.path.endsWith(".py"))) {
      showNotice("A running execution companion is required to apply non-Python files");
      return;
    }
    const mergedFiles = new Map(localPythonFiles.map((file) => [file.path, file]));
    files.forEach((file) => mergedFiles.set(file.path, file));
    const browserWorkspaceFiles = normalizePythonFiles(Array.from(mergedFiles.values()));
    if (browserWorkspaceFiles.length !== mergedFiles.size) {
      showNotice("The combined browser workspace exceeds 8 files or 120 KB · remove a saved file before approving");
      return;
    }
    const run = { files: browserWorkspaceFiles, execution };

    setLocalPythonFiles(browserWorkspaceFiles);
    setFolders((current) => new Set(current).add("__generated_python__"));
    setAcceptedFiles((current) => new Set([...current, ...files.map((file) => file.path)]));
    setSelectedGeneratedFile(entrypoint);
    setActiveFile(entrypoint);
    setViewMode("code");
    setApprovedPythonRun(run);
    setPendingProposal(null);
    setInspectorOpen(false);
    setTimeline((current) => [
      ...current.slice(-7),
      {
        id: `python-approved-${Date.now()}`,
        title: "Python proposal approved",
        detail: `${files.length} file${files.length === 1 ? "" : "s"} saved in this browser workspace`,
        time: nowTime(),
        state: "complete",
      },
    ]);
    await executePython(run);
  }

  function rejectPythonProposal() {
    if (!pendingProposal) return;
    const rejectedPaths = new Set(normalizePythonFiles(pendingProposal.artifacts).map((file) => file.path));
    setPendingProposal(null);
    if (rejectedPaths.has(activeFile) && !localPythonFiles.some((file) => file.path === activeFile)) {
      const fallbackFile = serverDiff?.file || changedFiles[0]?.id || INITIAL_FILE_TREE[0].id;
      setActiveFile(fallbackFile);
      setSelectedGeneratedFile(null);
    }
    setTimeline((current) => [
      ...current.slice(-7),
      {
        id: `python-rejected-${Date.now()}`,
        title: "Coding proposal rejected",
        detail: "No files were created and no code was executed",
        time: nowTime(),
        state: "complete",
      },
    ]);
    showNotice("Proposal rejected · workspace unchanged");
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
      const workspaceContextFiles = await collectRepositoryContext(message);
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          taskId: workspace.taskId,
          workspaceId: workspace.id,
          workspaceFiles: workspaceContextFiles,
          idempotencyKey: `agent-${Date.now()}`,
        }),
      });
      if (!response.ok) throw new Error("Agent unavailable");
      const data = (await response.json()) as AgentApiResponse;
      if (data.model) {
        agentModelOverride.current = data.model;
        setWorkspace((current) => ({ ...current, model: data.model as string }));
      }
      if (data.output) {
        setProposalOrigin({ mode: data.mode ?? "unknown", diagnostic: data.liveDiagnostic });
        const draftFiles = normalizePythonFiles(data.output.artifacts);
        if (draftFiles.length) {
          setPendingProposal(data.output);
          setSelectedGeneratedFile(draftFiles[0].path);
          setActiveFile(draftFiles[0].path);
          setViewMode("code");
          setInspectorOpen(true);
        } else {
          const rejectedArtifacts = Array.isArray(data.output.artifacts) && data.output.artifacts.length > 0;
          setPendingProposal(null);
          if (draftPythonFiles.some((file) => file.path === activeFile) && !localPythonFiles.some((file) => file.path === activeFile)) {
            setActiveFile(serverDiff?.file || changedFiles[0]?.id || INITIAL_FILE_TREE[0].id);
            setSelectedGeneratedFile(null);
          }
          setBottomPanel("terminal");
          setTerminalLines((current) => [
            ...current.slice(-16),
            { type: "muted", text: "" },
            { type: "info", text: ` Agent · ${data.output?.summary.replace(/\s+/g, " ")}` },
            ...(data.output?.plan ?? []).map((step, index) => ({ type: "output", text: ` ${index + 1}. ${step}` })),
            ...(data.mode === "demo" || data.liveDiagnostic
              ? [{ type: "pending", text: ` ${data.mode === "demo" ? "Fallback response" : "Live model fallback"} · ${data.liveDiagnostic || "demo mode"}` }]
              : []),
            ...(rejectedArtifacts
              ? [{ type: "error", text: " Proposed artifacts were rejected: paths or size limits did not match the browser sandbox policy." }]
              : []),
          ]);
        }
      }
      setApiState("connected");
      await loadWorkspace(true);
      showNotice(normalizePythonFiles(data.output?.artifacts).length ? "Proposal ready for review" : "Agent response ready");
    } catch {
      setApiState("preview");
      showNotice("Agent request failed · no files were created");
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
            {displayFileTree.map((node) => (
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
                {editorFiles.map((file) => (
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
                {selectedDraftFile && <span className="draft-badge">Draft · not applied</span>}
                <span className="addition-text">+{activeDiffStats.additions}</span>
                <span className="deletion-text">−{activeDiffStats.deletions}</span>
                <span className="reviewed-dot" aria-hidden="true" />
                {selectedDraftFile ? "review required" : "reviewed"}
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
              <span>{activeFile.endsWith(".py") ? "Python" : "TypeScript"}</span>
              <span className="status-spacer" />
              {selectedDraftFile ? (
                <span className="draft-status"><i aria-hidden="true">◌</i> draft only · no file created</span>
              ) : (
                <span className="safe-status"><i aria-hidden="true">✓</i> policy checked</span>
              )}
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
                  <div className="terminal-controls">
                    {executionResult && (
                      <span className={`execution-status ${executionState}`}>
                        exit {executionResult.exitCode ?? "—"}
                      </span>
                    )}
                    {approvedPythonRun && (
                      <button
                        type="button"
                        onClick={() => void executePython(approvedPythonRun)}
                        disabled={executionState === "running"}
                        data-testid="run-python-again"
                      >
                        {executionState === "running" ? "Running…" : "Run again"}
                      </button>
                    )}
                    <span className="terminal-sandbox"><i aria-hidden="true" /> {localGitConnected ? "Container workspace" : "Python sandbox"}</span>
                  </div>
                </div>
                <div className="terminal-lines">
                  {terminalLines.map((line, index) => (
                    <div className={`terminal-line ${line.type}`} key={`${index}-${line.text}`}>{line.text || " "}</div>
                  ))}
                </div>
                <form
                  className="terminal-input-row"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void executeTerminalCommand();
                  }}
                >
                  <span aria-hidden="true">$</span>
                  <input
                    value={terminalCommand}
                    onChange={(event) => setTerminalCommand(event.target.value)}
                    placeholder={localGitConnected ? "npm test, python3 main.py, git push…" : "Start the execution companion to enable terminal commands"}
                    aria-label="Terminal command"
                    disabled={!localGitConnected || busyAction === "terminal"}
                  />
                  <button type="submit" disabled={!localGitConnected || !terminalCommand.trim() || busyAction === "terminal"}>
                    {busyAction === "terminal" ? "Running…" : "Approve & run"}
                  </button>
                </form>
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

          {pendingProposal && (
            <section
              className="python-proposal-card"
              aria-labelledby="python-proposal-title"
              data-testid="python-proposal-review"
            >
              <div className="proposal-heading">
                <span className="python-mark" aria-hidden="true">AI</span>
                <div>
                  <span className="eyebrow">Coding agent proposal</span>
                  <h2 id="python-proposal-title">Review before applying files</h2>
                </div>
                <span className="risk-pill">{pendingProposal.riskLevel ?? "R1"} · local</span>
              </div>

              {(proposalOrigin.mode === "demo" || proposalOrigin.diagnostic) && (
                <div className="proposal-origin-warning" role="note">
                  <strong>{proposalOrigin.mode === "demo" ? "Fallback proposal" : "Live model fallback"}</strong>
                  <span>{proposalOrigin.diagnostic || "This response came from demo mode, not the configured live coding model."}</span>
                </div>
              )}

              <p className="proposal-summary">{pendingProposal.summary}</p>
              <div className="draft-notice">
                <span aria-hidden="true">◌</span>
                <div><strong>Draft · not applied</strong><span>Inspect the complete code in the editor before approving.</span></div>
              </div>

              <div className="proposal-file-heading">
                <span>Proposed files</span>
                <b>{draftPythonFiles.length}</b>
              </div>
              {draftPythonFiles.length ? (
                <ul className="proposal-files">
                  {draftPythonFiles.map((file) => (
                    <li key={file.path}>
                      <button
                        type="button"
                        className={selectedGeneratedFile === file.path ? "selected" : ""}
                        onClick={() => {
                          setSelectedGeneratedFile(file.path);
                          setActiveFile(file.path);
                          setViewMode("code");
                          setInspectorOpen(false);
                        }}
                        aria-pressed={selectedGeneratedFile === file.path}
                      >
                        <span className="proposal-file-icon">{file.language.slice(0, 3).toUpperCase()}</span>
                        <span>{file.path}</span>
                        <b>{file.content.split(/\r?\n/).length} lines</b>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="proposal-empty">No valid relative file artifacts were included.</div>
              )}

              <dl className="proposal-execution">
                <div><dt>Execution</dt><dd className={proposalEntrypoint ? "" : "invalid"}>{pendingProposal.execution?.command || proposalEntrypoint || "Invalid or missing"}</dd></div>
                <div><dt>Timeout</dt><dd>{proposalTimeoutMs} ms</dd></div>
                <div><dt>Arguments</dt><dd className={proposalArgs === null ? "invalid" : ""}>{proposalArgs === null ? "Invalid limits" : `${proposalArgs.length} supplied`}</dd></div>
              </dl>

              <div className="proposal-actions">
                <button
                  className="proposal-reject"
                  type="button"
                  onClick={rejectPythonProposal}
                  disabled={executionState === "running"}
                  data-testid="reject-python-proposal"
                >
                  Reject
                </button>
                <button
                  className="proposal-approve"
                  type="button"
                  onClick={() => void approvePythonProposal()}
                  disabled={!draftPythonFiles.length || !proposalEntrypoint || proposalArgs === null || executionState === "running"}
                  data-testid="approve-create-run"
                >
                  Approve, create &amp; run <span aria-hidden="true">→</span>
                </button>
              </div>
            </section>
          )}

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
  const extension = label.endsWith(".py") ? "PY" : label.endsWith(".json") ? "{}" : label.endsWith(".md") ? "#" : label.endsWith(".env.example") ? "·" : "TS";
  const shortStatus = status === "modified" ? "M" : status === "added" ? "A" : status === "local" ? "LOCAL" : status === "draft" ? "DRAFT" : status?.toUpperCase();
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
      {shortStatus && <span className={`file-status ${shortStatus === "A" ? "added" : ""} ${status ?? ""}`}>{shortStatus}</span>}
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
  const shortStatus = status === "modified" ? "M" : status === "added" ? "A" : status === "local" ? "LOCAL" : status === "draft" ? "DRAFT" : status?.toUpperCase();
  return (
    <button
      className={`editor-tab ${active ? "active" : ""}`}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(path)}
    >
      <span className="tab-language">{label.endsWith(".py") ? "PY" : "TS"}</span>
      <span>{label}</span>
      {shortStatus && <i className={`${shortStatus === "A" ? "added" : ""} ${status ?? ""}`}>{shortStatus}</i>}
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
