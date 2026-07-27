"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import "./portal.css";

const COMPANION_URL = "http://127.0.0.1:8765";
const WORKSPACE_ID = "workspace_local";

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
type AgentProposal = {
  summary: string;
  plan?: string[];
  riskLevel?: string;
  needsApproval?: boolean;
  artifacts?: AgentArtifact[];
  execution?: {
    entrypoint: string;
    command?: string;
    args?: string[];
    timeoutMs?: number;
  } | null;
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
  const [commitMessage, setCommitMessage] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryPrivate, setRepositoryPrivate] = useState(true);

  const activeTask = workspace.activeTask ?? workspace.tasks?.[0] ?? null;
  const companionReady = health?.ok === true;
  const allFiles = useMemo(() => flattenFiles(files), [files]);
  const visibleFiles = useMemo(() => {
    const query = fileFilter.trim().toLowerCase();
    return query ? allFiles.filter((file) => file.path.toLowerCase().includes(query)) : allFiles;
  }, [allFiles, fileFilter]);

  const refresh = useCallback(async () => {
    setError("");
    const results = await Promise.allSettled([
      fetch(`${COMPANION_URL}/health`, { cache: "no-store" }).then(readJson<CompanionHealth>),
      fetch(`${COMPANION_URL}/fs/tree?path=.&depth=6`, { cache: "no-store" })
        .then(readJson<{ entries: FileEntry[] }>),
      fetch(`${COMPANION_URL}/git/status`, { cache: "no-store" })
        .then(readJson<{ files?: GitFile[]; head?: string }>),
      fetch(`/api/workspace?workspaceId=${WORKSPACE_ID}`, { cache: "no-store" })
        .then(readJson<WorkspaceState>),
      fetch("/api/models", { cache: "no-store" })
        .then(readJson<{
          models?: string[];
          model?: string;
          modelStatus?: Record<string, ModelStatus>;
        }>),
    ]);

    const [healthResult, treeResult, gitResult, workspaceResult, modelResult] = results;
    if (healthResult.status === "fulfilled") setHealth(healthResult.value);
    else setHealth({ ok: false, error: "Local execution companion is not reachable." });
    if (treeResult.status === "fulfilled") setFiles(treeResult.value.entries);
    else setFiles([]);
    if (gitResult.status === "fulfilled") {
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
  }, [messages.length]);

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
            workspaceId: WORKSPACE_ID,
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
            workspaceId: WORKSPACE_ID,
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
      setMessages((current) => [...current, {
        id: `${key}-response`,
        role: "assistant",
        text: output.summary,
        plan: output.plan,
      }]);
      if (agentMode === "agent" && (
        output.artifacts?.length ||
        output.execution
      )) {
        setProposal(output);
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
    if (!proposal?.artifacts?.length) return;
    if (!window.confirm(
      `Apply ${proposal.artifacts.length} reviewed file(s) to the local workspace${proposal.execution ? " and run the verification command" : ""}?`,
    )) return;
    setBusy(true);
    setError("");
    setTerminalOutput("");
    try {
      await approvedCompanionAction(
        "fs.write",
        "/fs/write",
        {
          files: proposal.artifacts.map(({ path, content }) => ({ path, content })),
        },
      );
      if (proposal.execution) {
        const command = proposal.execution.command?.trim() ||
          `python "${proposal.execution.entrypoint}" ${(proposal.execution.args ?? []).map((arg) => JSON.stringify(arg)).join(" ")}`.trim();
        const result = await approvedCompanionAction<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>(
          "terminal.execute",
          "/terminal/execute",
          {
            command,
            cwd: ".",
            timeoutMs: proposal.execution.timeoutMs ?? 120_000,
          },
        );
        setTerminalOutput([
          `$ ${command}`,
          result.stdout,
          result.stderr,
          `exit ${result.exitCode}`,
        ].filter(Boolean).join("\n"));
        if (result.exitCode !== 0) throw new Error("Verification command failed. Review the output below.");
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
        <div className="portal-label">WORKSPACE</div>
        <div className="project-card">
          <span className="project-avatar">{companionReady ? "✓" : "!"}</span>
          <span>
            <strong>{health?.root?.split(/[\\/]/).pop() || "Not connected"}</strong>
            <small>{health?.branch || health?.error || "Start the companion"}</small>
          </span>
        </div>
        <button className="new-chat" type="button" onClick={() => void createTask()} disabled={busy}>
          <span>＋</span> New Agent task
        </button>
        <div className="portal-label manage-label">TASKS</div>
        <div className="task-list">
          {(workspace.tasks ?? []).map((task) => (
            <div className={`recent-chat ${task.id === activeTask?.id ? "selected" : ""}`} key={task.id}>
              <i />
              <span>
                <strong>{task.title || task.id}</strong>
                <small>{task.status || "unknown"} · {task.progress ?? 0}%</small>
              </span>
            </div>
          ))}
          {!workspace.tasks?.length && <p className="empty-copy">No durable task yet.</p>}
        </div>
        <div className="sidebar-spacer" />
        <div className={`connection-card ${companionReady ? "ready" : "offline"}`}>
          <strong>{companionReady ? "Execution companion connected" : "Execution companion offline"}</strong>
          <small>{health?.executionMode || "Run npm run companion:git or Docker Compose."}</small>
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
            <span className={companionReady ? "status-ready" : "status-offline"} />
            {companionReady ? `${health?.branch || "detached"} · ${gitHead || "no HEAD"}` : "Companion offline"}
            <button type="button" className="refresh-button" onClick={() => void refresh()} disabled={busy}>↻</button>
          </div>
        </header>

        {error && <div className="portal-error" role="alert">{error}</div>}
        <div className="portal-content">
          <div className="chat-column">
            {activeTab === "chat" && (
              <>
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
                  {busy && <div className="typing"><span /><span /><span /> Processing…</div>}
                </div>

                {proposal && (
                  <section className="proposal-card">
                    <div>
                      <strong>Review proposed workspace changes</strong>
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
                    {proposal.execution && <code>{proposal.execution.command || `python ${proposal.execution.entrypoint}`}</code>}
                    <div className="proposal-actions">
                      <button type="button" onClick={() => setProposal(null)} disabled={busy}>Reject</button>
                      <button type="button" onClick={() => void applyProposal()} disabled={busy || !companionReady}>Approve, apply & run</button>
                    </div>
                  </section>
                )}

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
                    <button type="button" onClick={() => void attachFiles()} disabled={!companionReady}>＋ Attach repository file</button>
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
                {terminalOutput && <pre className="terminal-output">{terminalOutput}</pre>}
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
                  <button type="button" onClick={() => void gitPush()} disabled={busy || !companionReady}>Review & push</button>
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
