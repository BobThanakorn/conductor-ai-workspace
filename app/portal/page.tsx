"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import "./portal.css";

const COMPANION_URL = "http://127.0.0.1:8765";
const DEFAULT_WORKSPACE_ID = "workspace_local";

type ModelStatus = "ready" | "configured" | "unavailable";
type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  plan?: string[];
};
type FileEntry = {
  path: string;
  name: string;
  type: "directory" | "file";
  children?: FileEntry[];
};
type GitFile = { code: string; path: string };
type Task = {
  id?: string;
  title?: string;
  status?: string;
  progress?: number;
  model?: string;
};
type AgentArtifact = { path: string; content: string; language: string };
type ExecutionStep = {
  entrypoint?: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
};
type ExecutionResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
};
type AgentProposal = {
  summary: string;
  plan?: string[];
  riskLevel?: string;
  needsApproval?: boolean;
  artifacts?: AgentArtifact[];
  execution?: ExecutionStep | null;
  executions?: ExecutionStep[];
};
type CompanionHealth = {
  ok?: boolean;
  root?: string;
  branch?: string;
  executionMode?: string;
  capabilities?: string[];
  integrations?: { github?: boolean };
  error?: string;
};
type WorkspaceState = {
  workspace?: {
    id?: string;
    name?: string;
    status?: string;
    repository?: {
      name?: string;
      path?: string;
      provider?: string;
      activeBranch?: string;
    };
  };
  activeTask?: Task | null;
  tasks?: Task[];
  recentAgentRuns?: Array<{
    id?: string;
    taskId?: string | null;
    summary?: string;
    plan?: string[];
    createdAt?: string;
  }>;
};
type RepositorySummary = {
  id: string;
  name: string;
  repositoryName: string;
  path: string;
  provider: string;
  defaultBranch: string;
  activeBranch: string;
  headSha: string;
  status: string;
  taskCount: number;
  recentTask?: {
    title?: string;
    status?: string;
    updatedAt?: string;
  } | null;
  updatedAt: string;
};

function uniqueKey(prefix: string) {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

function flattenFiles(entries: FileEntry[]): FileEntry[] {
  return entries.flatMap((entry) =>
    entry.type === "directory"
      ? flattenFiles(entry.children ?? [])
      : [entry],
  );
}

/**
 * A provider can occasionally return a prose-only plan even after being asked
 * for a structured batch. Preserve the user's exact, bounded commands as a
 * reviewable proposal rather than silently dropping the runnable request.
 */
function explicitCommandBatch(message: string): ExecutionStep[] {
  const commandPrefix = /^(?:python(?:3)?|node|npm|npx|pytest|go|cargo|dotnet|ruby|php|bash|sh)\b/i;
  const normalized = message
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*]|\d+[.)])\s*/, ""))
    .filter((line) => commandPrefix.test(line))
    .filter((line) => line.length <= 4_000 && !/[\u0000-\u001f\u007f;|&<>]/.test(line));
  return [...new Set(normalized)].slice(0, 8).map((command) => ({ command: normalizeExecutionCommand(command), args: [], timeoutMs: 120_000 }));
}

/** The Linux companion image provides python3; accept the friendlier `python` spelling in prompts. */
function normalizeExecutionCommand(command: string): string {
  return command.trim().replace(/^python(?=\s|$)/i, "python3");
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string | { message?: string } };
  if (!response.ok) {
    const detail = typeof data.error === "string"
      ? data.error
      : data.error?.message;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return data;
}

async function approvedCompanionAction<T>(
  action: string,
  endpoint: string,
  input: Record<string, unknown>,
): Promise<T> {
  const request = await readJson<{ approvalId: string; digest: string }>(
    await fetch(`${COMPANION_URL}/approvals/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, input }),
    }),
  );
  const approved = await readJson<{ token: string }>(
    await fetch(`${COMPANION_URL}/approvals/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm: true,
        approvalId: request.approvalId,
        digest: request.digest,
      }),
    }),
  );
  return readJson<T>(
    await fetch(`${COMPANION_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Conductor-Approval": approved.token,
      },
      body: JSON.stringify(input),
    }),
  );
}

export default function PortalPage() {
  const [activeTab, setActiveTab] = useState<"chat" | "git" | "project">("chat");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [agentMode, setAgentMode] = useState<"ask" | "agent">("agent");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<CompanionHealth | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceState>({});
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [gitFiles, setGitFiles] = useState<GitFile[]>([]);
  const [gitHead, setGitHead] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [contextFiles, setContextFiles] = useState<Array<{ path: string; content: string }>>([]);
  const [fileFilter, setFileFilter] = useState("");
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [models, setModels] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState<Record<string, ModelStatus>>({});
  const [selectedModel, setSelectedModel] = useState("");
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  const [terminalOutput, setTerminalOutput] = useState("");
  const [executionResults, setExecutionResults] = useState<ExecutionResult[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryPrivate, setRepositoryPrivate] = useState(true);
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(DEFAULT_WORKSPACE_ID);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [repositoryFilter, setRepositoryFilter] = useState("");

  const activeTask = workspace.activeTask ?? workspace.tasks?.[0] ?? null;
  const companionReady = health?.ok === true;
  const selectedRepository = repositories.find((repository) => repository.id === selectedWorkspaceId);
  const workspaceRuntimeReady = companionReady &&
    (!selectedRepository || selectedRepository.path === health?.root);
  const allFiles = useMemo(() => flattenFiles(files), [files]);
  const visibleFiles = useMemo(() => {
    const query = fileFilter.trim().toLowerCase();
    return query ? allFiles.filter((file) => file.path.toLowerCase().includes(query)) : allFiles;
  }, [allFiles, fileFilter]);
  const visibleRepositories = useMemo(() => {
    const query = repositoryFilter.trim().toLowerCase();
    return query
      ? repositories.filter((repository) =>
          `${repository.name} ${repository.repositoryName}`.toLowerCase().includes(query),
        )
      : repositories;
  }, [repositories, repositoryFilter]);

  const refresh = useCallback(async () => {
    setError("");
    const workspaceQuery = new URLSearchParams({ workspaceId: selectedWorkspaceId });
    if (selectedTaskId) workspaceQuery.set("taskId", selectedTaskId);
    const results = await Promise.allSettled([
      fetch(`${COMPANION_URL}/health`, { cache: "no-store" }).then(readJson<CompanionHealth>),
      fetch(`${COMPANION_URL}/fs/tree?path=.&depth=6`, { cache: "no-store" })
        .then(readJson<{ entries: FileEntry[] }>),
      fetch(`${COMPANION_URL}/git/status`, { cache: "no-store" })
        .then(readJson<{ files?: GitFile[]; head?: string }>),
      fetch(`/api/workspace?${workspaceQuery}`, { cache: "no-store" })
        .then(readJson<WorkspaceState>),
      fetch("/api/repositories", { cache: "no-store" })
        .then(readJson<{ repositories?: RepositorySummary[] }>),
      fetch("/api/models", { cache: "no-store" })
        .then(readJson<{
          models?: string[];
          model?: string;
          modelStatus?: Record<string, ModelStatus>;
        }>),
    ]);

    const [healthResult, treeResult, gitResult, workspaceResult, repositoriesResult, modelResult] = results;
    const nextHealth = healthResult.status === "fulfilled"
      ? healthResult.value
      : { ok: false, error: "Local execution companion is not reachable." };
    const nextRepositories = repositoriesResult.status === "fulfilled"
      ? repositoriesResult.value.repositories ?? []
      : [];
    const nextSelectedRepository = nextRepositories.find((repository) =>
      repository.id === selectedWorkspaceId
    );
    const runtimeMatchesSelection = nextHealth.ok === true &&
      (!nextSelectedRepository || nextSelectedRepository.path === nextHealth.root);

    setHealth(nextHealth);
    if (runtimeMatchesSelection && treeResult.status === "fulfilled") setFiles(treeResult.value.entries);
    else setFiles([]);
    if (runtimeMatchesSelection && gitResult.status === "fulfilled") {
      setGitFiles(gitResult.value.files ?? []);
      setGitHead(gitResult.value.head ?? "");
    } else {
      setGitFiles([]);
      setGitHead("");
    }
    if (workspaceResult.status === "fulfilled") {
      setWorkspace(workspaceResult.value);
      if (!messages.length && workspaceResult.value.recentAgentRuns?.length) {
        setMessages(workspaceResult.value.recentAgentRuns.slice().reverse().map((run, index) => ({
          id: run.id ?? `restored-${index}`,
          role: "assistant",
          text: run.summary ?? "Agent run completed.",
          plan: run.plan,
        })));
      }
    }
    if (repositoriesResult.status === "fulfilled") {
      setRepositories(nextRepositories);
    }
    if (modelResult.status === "fulfilled") {
      const options = Array.from(new Set([
        modelResult.value.model,
        ...(modelResult.value.models ?? []),
      ].filter((value): value is string => Boolean(value))));
      setModels(options);
      setModelStatus(modelResult.value.modelStatus ?? {});
      const firstReady = options.find((model) =>
        (modelResult.value.modelStatus?.[model] ?? "configured") === "ready",
      ) ?? "";
      setSelectedModel((current) =>
        current && options.includes(current) ? current : firstReady,
      );
    }
  }, [messages.length, selectedTaskId, selectedWorkspaceId]);

  useEffect(() => {
    const pending = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(pending);
  }, [refresh]);

  async function createTask() {
    const title = window.prompt("Task name");
    if (!title?.trim()) return;
    const goal = window.prompt("What should the Agent build, change, or verify?", title);
    if (!goal?.trim()) return;
    const key = uniqueKey("task");
    setBusy(true);
    setError("");
    try {
      await readJson(
        await fetch("/api/workspace", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify({
            action: "create_task",
            workspaceId: selectedWorkspaceId,
            idempotencyKey: key,
            title: title.trim(),
            goal: goal.trim(),
            riskLevel: "R1",
          }),
        }),
      );
      setMessages([]);
      setProposal(null);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Task creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function connectCurrentRepository() {
    if (!health?.ok || !health.root) {
      setError("Connect the local execution companion before adding a repository.");
      return;
    }
    const name = health.root.split(/[\\/]/).filter(Boolean).at(-1) || "workspace";
    setBusy(true);
    setError("");
    try {
      const result = await readJson<{ repository: { id: string } }>(
        await fetch("/api/repositories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            path: health.root,
            provider: "local",
            defaultBranch: health.branch || "main",
            activeBranch: health.branch || "main",
            baseSha: gitHead,
            headSha: gitHead,
          }),
        }),
      );
      setSelectedWorkspaceId(result.repository.id);
      setSelectedTaskId("");
      setMessages([]);
      setProposal(null);
      setExecutionResults([]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Repository connection failed.");
    } finally {
      setBusy(false);
    }
  }

  async function cloneRepository() {
    const repositoryUrl = window.prompt("GitHub repository URL (HTTPS)");
    if (!repositoryUrl?.trim()) return;
    if (!window.confirm(`Clone ${repositoryUrl.trim()} into the isolated workspace?`)) return;
    setBusy(true);
    setError("");
    try {
      const cloned = await approvedCompanionAction<{
        name: string;
        root: string;
        branch: string;
        head: string;
      }>("git.clone", "/git/clone", { url: repositoryUrl.trim() });
      const registered = await readJson<{ repository: { id: string } }>(
        await fetch("/api/repositories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: cloned.name,
            path: cloned.root,
            provider: "github",
            defaultBranch: cloned.branch || "main",
            activeBranch: cloned.branch || "main",
            baseSha: cloned.head,
            headSha: cloned.head,
          }),
        }),
      );
      setSelectedWorkspaceId(registered.repository.id);
      setSelectedTaskId("");
      setMessages([]);
      setProposal(null);
      setExecutionResults([]);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Repository clone failed.");
    } finally {
      setBusy(false);
    }
  }

  async function selectRepository(repositoryId: string) {
    if (repositoryId === selectedWorkspaceId) return;
    const repository = repositories.find((item) => item.id === repositoryId);
    if (!repository) return;
    setBusy(true);
    setError("");
    try {
      await readJson(
        await fetch(`${COMPANION_URL}/workspace/select`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: repository.path }),
        }),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Repository runtime selection failed.");
    }
    setSelectedWorkspaceId(repositoryId);
    setSelectedTaskId("");
    setWorkspace({});
    setMessages([]);
    setProposal(null);
    setExecutionResults([]);
    setContextFiles([]);
    setBusy(false);
  }

  function selectTask(taskId: string) {
    if (taskId === selectedTaskId) return;
    setSelectedTaskId(taskId);
    setMessages([]);
    setProposal(null);
    setExecutionResults([]);
  }

  async function openFile(path: string, addToContext = false) {
    setError("");
    try {
      const data = await readJson<{ content: string }>(
        await fetch(`${COMPANION_URL}/fs/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        }),
      );
      setSelectedFile(path);
      setFileContent(data.content);
      if (addToContext) {
        setContextFiles((current) => [
          ...current.filter((file) => file.path !== path),
          { path, content: data.content },
        ].slice(-8));
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "File read failed.");
    }
  }

  async function attachFiles() {
    if (!allFiles.length) return;
    const path = window.prompt(
      "Repository-relative file to attach",
      selectedFile || allFiles[0].path,
    );
    if (path?.trim()) await openFile(path.trim(), true);
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = prompt.trim();
    if (!message || busy || !selectedModel) return;
    const key = uniqueKey("agent");
    setPrompt("");
    setBusy(true);
    setError("");
    setProposal(null);
    setExecutionResults([]);
    setMessages((current) => [...current, {
      id: key,
      role: "user",
      text: message,
    }]);
    try {
      const data = await readJson<{ output?: AgentProposal; model?: string }>(
        await fetch("/api/agent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify({
            message,
            mode: agentMode,
            model: selectedModel,
            taskId: activeTask?.id,
            workspaceId: selectedWorkspaceId,
            idempotencyKey: key,
            workspaceFiles: contextFiles,
            workspace: {
              repository: health?.root ?? "Local workspace",
              branch: health?.branch,
              headSha: gitHead,
            },
          }),
        }),
      );
      if (!data.output) throw new Error("The provider returned no Agent output.");
      const output = data.output;
      const fallbackExecutions = agentMode === "agent" &&
        !output.execution &&
        !output.executions?.length
        ? explicitCommandBatch(message)
        : [];
      const proposalOutput = fallbackExecutions.length
        ? {
            ...output,
            summary: `${output.summary} A reviewed command batch was reconstructed from the exact commands in your request.`,
            executions: fallbackExecutions,
            riskLevel: "R1",
            needsApproval: true,
          }
        : output;
      setMessages((current) => [...current, {
        id: `${key}-response`,
        role: "assistant",
        text: proposalOutput.summary,
        plan: proposalOutput.plan,
      }]);
      if (agentMode === "agent" && (
        proposalOutput.artifacts?.length ||
        proposalOutput.execution ||
        proposalOutput.executions?.length
      )) {
        setProposal(proposalOutput);
      }
      await refresh();
    } catch (failure) {
      const messageText = failure instanceof Error ? failure.message : "Agent request failed.";
      setError(messageText);
      setMessages((current) => [...current, {
        id: `${key}-error`,
        role: "system",
        text: messageText,
      }]);
    } finally {
      setBusy(false);
    }
  }

  async function applyProposal() {
    if (!proposal) return;
    const executions = [
      ...(proposal.execution ? [proposal.execution] : []),
      ...(proposal.executions ?? []),
    ];
    if (!(proposal.artifacts?.length || executions.length)) return;
    if (!window.confirm(
      `Apply ${proposal.artifacts?.length ?? 0} reviewed file(s) to the local workspace${executions.length ? ` and run ${executions.length} reviewed command(s)` : ""}?`,
    )) return;
    setBusy(true);
    setError("");
    setExecutionResults([]);
    try {
      if (proposal.artifacts?.length) {
        await approvedCompanionAction(
          "fs.write",
          "/fs/write",
          {
            files: proposal.artifacts.map(({ path, content }) => ({ path, content })),
          },
        );
      }
      if (executions.length) {
        const commands = executions.map((execution) => ({
          command: normalizeExecutionCommand(execution.command?.trim() ||
            `python "${execution.entrypoint ?? ""}" ${(execution.args ?? []).map((arg) => JSON.stringify(arg)).join(" ")}`.trim()),
          cwd: ".",
          timeoutMs: execution.timeoutMs ?? 120_000,
        }));
        const result = await approvedCompanionAction<{ results: ExecutionResult[] }>(
          "terminal.execute-batch",
          "/terminal/execute-batch",
          { commands },
        );
        setExecutionResults(result.results);
      }
      setProposal(null);
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Proposal execution failed.");
    } finally {
      setBusy(false);
    }
  }

  async function gitCommit() {
    const message = commitMessage.trim();
    if (!message || !gitFiles.length) return;
    if (!window.confirm(`Commit ${gitFiles.length} changed file(s) with message "${message}"?`)) return;
    setBusy(true);
    setError("");
    try {
      const result = await approvedCompanionAction<{ head?: string; stdout?: string }>(
        "git.commit",
        "/git/commit",
        { paths: gitFiles.map((file) => file.path), message },
      );
      setTerminalOutput(result.stdout ?? `Committed ${result.head ?? ""}`);
      setCommitMessage("");
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Git commit failed.");
    } finally {
      setBusy(false);
    }
  }

  async function gitPush() {
    if (!window.confirm(`Push branch ${health?.branch || "current branch"} to its configured remote?`)) return;
    setBusy(true);
    setError("");
    try {
      const result = await approvedCompanionAction<{ stdout?: string; stderr?: string }>(
        "git.remote",
        "/git/action",
        { operation: "push", args: [] },
      );
      setTerminalOutput([result.stdout, result.stderr].filter(Boolean).join("\n") || "Push completed.");
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Git push failed.");
    } finally {
      setBusy(false);
    }
  }

  async function createRepository(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = repositoryName.trim();
    if (!name) return;
    if (!window.confirm(`Create ${repositoryPrivate ? "private" : "public"} GitHub repository "${name}"?`)) return;
    setBusy(true);
    setError("");
    try {
      const result = await approvedCompanionAction<{
        repository?: string;
        url?: string;
        cloneUrl?: string;
      }>(
        "github.create-repository",
        "/provider/github/repository",
        { name, description: "", private: repositoryPrivate, autoInit: false },
      );
      setTerminalOutput(`Created ${result.repository}\n${result.url ?? ""}\n${result.cloneUrl ?? ""}`);
      setRepositoryName("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "GitHub repository creation failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="portal-shell">
      <aside className="portal-sidebar" aria-label="Workspace navigation">
        <div className="repository-sidebar-heading">
          <div className="portal-label">REPOSITORIES</div>
          <div>
            <button type="button" onClick={() => void connectCurrentRepository()} disabled={busy || !companionReady} aria-label="Connect current repository">▣</button>
            <button type="button" onClick={() => void cloneRepository()} disabled={busy || !companionReady} aria-label="Clone GitHub repository">＋</button>
          </div>
        </div>
        <input
          className="repository-filter"
          value={repositoryFilter}
          onChange={(event) => setRepositoryFilter(event.target.value)}
          placeholder="Search repositories…"
          aria-label="Search repositories"
        />
        <div className="repository-list">
          {visibleRepositories.map((repository) => (
            <button
              className={`repository-item ${repository.id === selectedWorkspaceId ? "selected" : ""}`}
              type="button"
              key={repository.id}
              onClick={() => selectRepository(repository.id)}
            >
              <span className="repository-folder">▱</span>
              <span>
                <strong>{repository.repositoryName || repository.name}</strong>
                <small>{repository.activeBranch || repository.status}</small>
                {repository.recentTask?.title && (
                  <em>
                    <span>{repository.recentTask.title}</span>
                    <time>{repository.recentTask.status}</time>
                  </em>
                )}
              </span>
            </button>
          ))}
          {!visibleRepositories.length && (
            <p className="empty-copy">No connected repositories.</p>
          )}
        </div>
        <button className="new-chat" type="button" onClick={() => void createTask()} disabled={busy}>
          <span>＋</span> New Agent task
        </button>
        <div className="portal-label manage-label">TASKS</div>
        <div className="task-list">
          {(workspace.tasks ?? []).map((task) => (
            <button
              className={`recent-chat ${task.id === activeTask?.id ? "selected" : ""}`}
              type="button"
              key={task.id}
              onClick={() => task.id && selectTask(task.id)}
            >
              <i />
              <span>
                <strong>{task.title || task.id}</strong>
                <small>{task.status || "unknown"}</small>
              </span>
            </button>
          ))}
          {!workspace.tasks?.length && <p className="empty-copy">No durable task yet.</p>}
        </div>
        <div className="sidebar-spacer" />
        <div className={`connection-card ${workspaceRuntimeReady ? "ready" : "offline"}`}>
          <strong>{workspaceRuntimeReady ? "Repository runtime connected" : "Repository runtime unavailable"}</strong>
          <small>{workspaceRuntimeReady ? health?.executionMode : "Select or connect the repository mounted by the companion."}</small>
        </div>
      </aside>

      <section className="portal-main">
        <header className="portal-header">
          <div className="portal-tabs" role="tablist" aria-label="Workspace sections">
            <button type="button" className={activeTab === "chat" ? "active" : ""} onClick={() => setActiveTab("chat")}>◌ Chat</button>
            <button type="button" className={activeTab === "git" ? "active" : ""} onClick={() => setActiveTab("git")}>⑂ Git</button>
            <button type="button" className={activeTab === "project" ? "active" : ""} onClick={() => setActiveTab("project")}>▣ Project</button>
          </div>
          <div className="header-status">
            <span className={workspaceRuntimeReady ? "status-ready" : "status-offline"} />
            {workspaceRuntimeReady ? `${health?.branch || "detached"} · ${gitHead || "no HEAD"}` : "Repository runtime unavailable"}
            <button type="button" className="refresh-button" onClick={() => void refresh()} disabled={busy}>↻</button>
          </div>
        </header>

        {error && <div className="portal-error" role="alert">{error}</div>}
        <div className="portal-content">
          <div className="chat-column">
            {activeTab === "chat" && (
              <>
                <div className="chat-scroll">
                  <div className="assistant-heading">
                  <span className="assistant-avatar">AI</span>
                  <div>
                    <strong>Conductor Agent</strong>
                    <small>{activeTask?.title || "Create a task to begin"}</small>
                  </div>
                  </div>
                  <div className="message-list">
                  {!messages.length && (
                    <div className="empty-state">
                      <h2>Ready when the runtime is ready</h2>
                      <p>Select a ready model, attach repository files when needed, then ask or propose a change.</p>
                    </div>
                  )}
                  {messages.map((message) => (
                    <article className={`portal-message ${message.role}`} key={message.id}>
                      <span className={message.role === "user" ? "user-avatar" : "assistant-avatar small"}>
                        {message.role === "user" ? "U" : message.role === "system" ? "!" : "AI"}
                      </span>
                      <div>
                        <div className="message-meta">{message.role}</div>
                        <p>{message.text}</p>
                        {message.plan?.length ? <ol>{message.plan.map((step) => <li key={step}>{step}</li>)}</ol> : null}
                      </div>
                    </article>
                  ))}
                  {executionResults.length > 0 && (
                    <article className="execution-result" aria-label="Execution result">
                      <div className="execution-result-heading">
                        <span className="execution-result-icon">›_</span>
                        <div>
                          <strong>Execution result</strong>
                          <small>{executionResults.length} command{executionResults.length === 1 ? "" : "s"} completed</small>
                        </div>
                      </div>
                      <div className="execution-result-steps">
                        {executionResults.map((result, index) => (
                          <section className={result.exitCode === 0 ? "execution-step success" : "execution-step failure"} key={`${result.command}-${index}`}>
                            <div className="execution-step-meta">
                              <code>$ {result.command}</code>
                              <span>{result.exitCode === 0 ? "Passed" : "Failed"} · exit {result.exitCode} · {result.durationMs} ms</span>
                            </div>
                            {(result.stdout || result.stderr) && (
                              <pre className="terminal-output">
                                {result.stdout}
                                {result.stderr && <span className="stderr-output">{result.stderr}</span>}
                              </pre>
                            )}
                            {!result.stdout && !result.stderr && <p className="execution-empty">Command completed without output.</p>}
                          </section>
                        ))}
                      </div>
                    </article>
                  )}
                  {busy && <div className="typing"><span /><span /><span /> Processing…</div>}
                  </div>

                {proposal && (
                  <section className="proposal-card">
                    <div>
                      <strong>{proposal.artifacts?.length ? "Review proposed workspace changes" : "Review proposed command batch"}</strong>
                      <small>{proposal.riskLevel || "R1"} · approval required</small>
                    </div>
                    <ul>
                      {(proposal.artifacts ?? []).map((artifact) => (
                        <li key={artifact.path}>
                          <button type="button" onClick={() => {
                            setSelectedFile(artifact.path);
                            setFileContent(artifact.content);
                            setWorkspaceOpen(true);
                          }}>{artifact.path}</button>
                        </li>
                      ))}
                    </ul>
                    {[...(proposal.execution ? [proposal.execution] : []), ...(proposal.executions ?? [])].map((execution, index) => (
                      <code key={`${execution.entrypoint ?? "command"}-${index}`}>{execution.command || `python ${execution.entrypoint ?? ""} ${(execution.args ?? []).join(" ")}`}</code>
                    ))}
                    <div className="proposal-actions">
                      <button type="button" onClick={() => setProposal(null)} disabled={busy}>Reject</button>
                      <button type="button" onClick={() => void applyProposal()} disabled={busy || !workspaceRuntimeReady}>
                        {proposal.artifacts?.length ? "Approve, apply & run" : "Approve & run"}
                      </button>
                    </div>
                  </section>
                )}
                </div>

                <form className="portal-composer" onSubmit={sendMessage}>
                  <textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="Ask about the repository or request a code change…"
                    rows={3}
                    aria-label="Message the Conductor Agent"
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        event.currentTarget.form?.requestSubmit();
                      }
                    }}
                  />
                  <div className="composer-toolbar">
                    <button type="button" onClick={() => void attachFiles()} disabled={!workspaceRuntimeReady}>＋ Attach repository file</button>
                    <button type="button" className={agentMode === "ask" ? "selected" : ""} onClick={() => setAgentMode("ask")}>Ask</button>
                    <button type="button" className={agentMode === "agent" ? "selected" : ""} onClick={() => setAgentMode("agent")}>Agent</button>
                    <span className="context-count">{contextFiles.length} context file(s)</span>
                    <span className="composer-spacer" />
                    <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} aria-label="Select model">
                      {!models.length && <option value="">No ready model</option>}
                      {models.map((model) => {
                        const status = modelStatus[model] ?? "configured";
                        return <option key={model} value={model} disabled={status !== "ready"}>{model} · {status}</option>;
                      })}
                    </select>
                    <button className="send-message" type="submit" disabled={!prompt.trim() || busy || !selectedModel}>↑</button>
                  </div>
                </form>
              </>
            )}

            {activeTab === "git" && (
              <section className="real-panel">
                <h1>Git workspace</h1>
                <p>{health?.root || "The execution companion is not connected."}</p>
                <div className="git-summary">
                  <strong>{gitFiles.length} changed file(s)</strong>
                  <span>{health?.branch || "no branch"} · {gitHead || "no commit"}</span>
                </div>
                <ul className="git-files">
                  {gitFiles.map((file) => <li key={file.path}><code>{file.code}</code><button type="button" onClick={() => void openFile(file.path)}>{file.path}</button></li>)}
                </ul>
                {!gitFiles.length && <p className="empty-copy">Working tree clean or Git is unavailable.</p>}
                <div className="git-actions">
                  <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Commit message" maxLength={200} />
                  <button type="button" onClick={() => void gitCommit()} disabled={busy || !gitFiles.length || !commitMessage.trim()}>Review & commit</button>
                  <button type="button" onClick={() => void gitPush()} disabled={busy || !workspaceRuntimeReady}>Review & push</button>
                </div>
                {terminalOutput && <pre className="terminal-output">{terminalOutput}</pre>}
              </section>
            )}

            {activeTab === "project" && (
              <section className="real-panel">
                <h1>Runtime and repository</h1>
                <dl className="runtime-grid">
                  <div><dt>Workspace</dt><dd>{health?.root || "Not connected"}</dd></div>
                  <div><dt>Branch</dt><dd>{health?.branch || "Unavailable"}</dd></div>
                  <div><dt>Execution</dt><dd>{health?.executionMode || "Unavailable"}</dd></div>
                  <div><dt>Capabilities</dt><dd>{health?.capabilities?.join(", ") || "None reported"}</dd></div>
                </dl>
                <h2>Create a GitHub repository</h2>
                <form className="repository-form" onSubmit={createRepository}>
                  <input value={repositoryName} onChange={(event) => setRepositoryName(event.target.value)} placeholder="repository-name" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,99}" required />
                  <label><input type="checkbox" checked={repositoryPrivate} onChange={(event) => setRepositoryPrivate(event.target.checked)} /> Private</label>
                  <button type="submit" disabled={busy || !companionReady || !health?.integrations?.github}>Review & create</button>
                </form>
                <p className="form-help">
                  {health?.integrations?.github
                    ? "GitHub is configured. Creation is payload-bound and confirmation-gated."
                    : "GitHub is not configured. Add GITHUB_TOKEN to .env and restart Docker Compose."}
                </p>
                {terminalOutput && <pre className="terminal-output">{terminalOutput}</pre>}
              </section>
            )}
          </div>

          {workspaceOpen && (
            <aside className="portal-workspace" aria-label="Repository files">
              <div className="workspace-heading">
                <strong>▱ repository</strong>
                <div>
                  <button type="button" aria-label="Refresh workspace" onClick={() => void refresh()}>↻</button>
                  <button type="button" aria-label="Close workspace" onClick={() => setWorkspaceOpen(false)}>×</button>
                </div>
              </div>
              <div className="workspace-section-label">FILES <span>{allFiles.length}</span></div>
              <input
                className="workspace-file-filter"
                value={fileFilter}
                onChange={(event) => setFileFilter(event.target.value)}
                placeholder="Search files…"
                aria-label="Search repository files"
              />
              <div className="workspace-file-list">
                {visibleFiles.map((file) => (
                  <button className={`workspace-file ${selectedFile === file.path ? "active" : ""}`} type="button" key={file.path} onClick={() => void openFile(file.path)}>
                    <span>◫</span><strong>{file.path}</strong>
                  </button>
                ))}
                {!visibleFiles.length && <p className="empty-copy">No matching files.</p>}
              </div>
              {selectedFile && (
                <>
                  <div className="workspace-divider" />
                  <div className="workspace-section-label">{selectedFile}</div>
                  <pre className="file-preview">{fileContent}</pre>
                  <button type="button" className="attach-current" onClick={() => setContextFiles((current) => [
                    ...current.filter((file) => file.path !== selectedFile),
                    { path: selectedFile, content: fileContent },
                  ].slice(-8))}>Add to Agent context</button>
                </>
              )}
              <button className="open-old-workspace" type="button" onClick={() => window.location.assign("/code")}>Open full Code Workspace →</button>
            </aside>
          )}
          {!workspaceOpen && <button className="workspace-reopen" type="button" onClick={() => setWorkspaceOpen(true)}>▱ Repository</button>}
        </div>
      </section>
    </main>
  );
}
