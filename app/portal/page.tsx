"use client";

import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import "./portal.css";
import { invokeApprovedCompanionTool, type CompanionToolId } from "@/lib/agent-tool-adapter";
import { recoverExplicitCommandBatch } from "@/lib/agent-safety";
import { McpPermissionsPanel } from "./mcp-permissions-panel";
import { AutomationsPanel } from "./automations-panel";

// The browser never reaches a companion port directly. The server-side proxy is
// a bounded route allowlist over the private Compose network.
const COMPANION_URL = "/api/companion";
const LANGGRAPH_COMPANION_URL = "/api/companion/langgraph";
const DEFAULT_WORKSPACE_ID = "workspace_local";

type ModelStatus = "ready" | "configured" | "unavailable";
type PortalTab = "chat" | "git" | "project" | "mcp" | "automations" | "benchmark";
type AgentEngine = {
  id: "conductor-native" | "openai-agents" | "langgraph" | "pydantic-ai" | "crewai"
    | "microsoft-agent-framework" | "llamaindex" | "haystack" | "semantic-kernel";
  name: string;
  source: string;
  status: ModelStatus;
  class: "agentic" | "ask-only" | "retrieval";
  toolLoop: boolean;
  codingReady: boolean;
  notes: string;
};

const ENGINE_LABELS: Record<AgentEngine["id"], string> = {
  "conductor-native": "Conductor Native · Tesseract",
  "openai-agents": "OpenAI Agents SDK",
  langgraph: "LangChain + LangGraph",
  "pydantic-ai": "PydanticAI",
  crewai: "CrewAI",
  "microsoft-agent-framework": "Microsoft Agent Framework",
  llamaindex: "LlamaIndex",
  haystack: "Haystack",
  "semantic-kernel": "Semantic Kernel",
};

function engineLabel(engine?: string): string | undefined {
  return engine && engine in ENGINE_LABELS
    ? ENGINE_LABELS[engine as AgentEngine["id"]]
    : engine;
}

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  plan?: string[];
  telemetry?: AgentTelemetry;
  framework?: string;
  model?: string;
};
type AgentTelemetry = {
  durationMs: number;
  providerDurationMs?: number;
  tokenUsage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  tools: Array<{ name: string; status: string }>;
  auditLog: Array<{ at: string; stage: string; detail: string }>;
};
type BenchmarkResult = {
  engine: AgentEngine["id"];
  engineName: string;
  model: string;
  question: string;
  answer: string;
  ok: boolean;
  telemetry: AgentTelemetry;
  error?: string;
};
type AgentRunRecord = {
  id?: string;
  taskId?: string | null;
  summary?: string;
  plan?: string[];
  createdAt?: string;
  question?: string;
  answer?: string;
  engine?: string;
  model?: string;
  telemetry?: AgentTelemetry;
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
type AgentContract = {
  contractVersion: 2;
  mutation: Record<string, unknown>;
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
  recentAgentRuns?: AgentRunRecord[];
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
type HandoffRecord = {
  id: string;
  taskId: string;
  fromRole: string;
  toRole: string;
  submittedBy?: string;
  status: string;
  evidenceDigest: string;
  createdAt: string;
};
type HandoffDetailRecord = HandoffRecord & {
  context: {
    snapshotId: string;
    files: Array<{ path: string; content: string; snapshotId: string }>;
    totalTokens: number;
  };
  evidence: {
    summary: string;
    files: Array<{ path: string; change: string }>;
    checks: Array<{ command: string; exitCode: number; stdout?: string; stderr?: string }>;
  };
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
  companionUrl: string,
  action: string,
  endpoint: string,
  input: Record<string, unknown>,
  contractMutation?: unknown,
): Promise<T> {
  void endpoint;
  return invokeApprovedCompanionTool<T>({
    baseUrl: companionUrl,
    tool: action as CompanionToolId,
    input,
    contractMutation,
  });
}

export default function PortalPage() {
  const [activeTab, setActiveTab] = useState<PortalTab>("chat");
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
  const [selectedModel, setSelectedModel] = useState("");
  const [skillCatalog, setSkillCatalog] = useState<Array<{
    id: string;
    name: string;
    description: string;
    disableModelInvocation: boolean;
  }>>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [engines, setEngines] = useState<AgentEngine[]>([]);
  const [selectedEngine, setSelectedEngine] = useState<AgentEngine["id"]>("openai-agents");
  const [proposal, setProposal] = useState<AgentProposal | null>(null);
  const [pendingContract, setPendingContract] = useState<AgentContract | null>(null);
  const [terminalOutput, setTerminalOutput] = useState("");
  const [executionResults, setExecutionResults] = useState<ExecutionResult[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(DEFAULT_WORKSPACE_ID);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [repositoryFilter, setRepositoryFilter] = useState("");
  const [benchmarkPrompt, setBenchmarkPrompt] = useState(
    "Explain in three concise bullet points what this repository does. Do not modify files or run commands.",
  );
  const [benchmarkResults, setBenchmarkResults] = useState<BenchmarkResult[]>([]);
  const [benchmarkContextPaths, setBenchmarkContextPaths] = useState<string[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  const [handoffIdentity, setHandoffIdentity] = useState("");
  const [handoffDetails, setHandoffDetails] = useState<Record<string, HandoffDetailRecord>>({});

  const activeTask = workspace.activeTask ?? workspace.tasks?.[0] ?? null;
  const companionUrl = selectedEngine === "langgraph"
    ? LANGGRAPH_COMPANION_URL
    : COMPANION_URL;
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

  function portalTabProps(tab: PortalTab) {
    return {
      id: `portal-tab-${tab}`,
      role: "tab" as const,
      "aria-selected": activeTab === tab,
      "aria-controls": "portal-active-panel",
      tabIndex: activeTab === tab ? 0 : -1,
      onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        const tabs = Array.from(
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']") ?? [],
        );
        const current = tabs.indexOf(event.currentTarget);
        const next = event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : event.key === "ArrowRight"
              ? (current + 1) % tabs.length
              : event.key === "ArrowLeft"
                ? (current - 1 + tabs.length) % tabs.length
                : -1;
        if (next < 0) return;
        event.preventDefault();
        tabs[next]?.focus();
        tabs[next]?.click();
      },
    };
  }

  const refresh = useCallback(async () => {
    setError("");
    const workspaceQuery = new URLSearchParams({ workspaceId: selectedWorkspaceId });
    if (selectedTaskId) workspaceQuery.set("taskId", selectedTaskId);
    const results = await Promise.allSettled([
      fetch(`${companionUrl}/health`, { cache: "no-store" }).then(readJson<CompanionHealth>),
      fetch(`${companionUrl}/fs/tree?path=.&depth=6`, { cache: "no-store" })
        .then(readJson<{ entries: FileEntry[] }>),
      fetch(`${companionUrl}/git/status`, { cache: "no-store" })
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
          engines?: AgentEngine[];
        }>),
      fetch("/api/skills", { cache: "no-store" })
        .then(readJson<{ catalog?: Array<{ id: string; name: string; description: string; disableModelInvocation: boolean }> }>),
      fetch(`/api/handoffs?${workspaceQuery}`, { cache: "no-store" })
        .then(readJson<{ handoffs?: HandoffRecord[] }>),
    ]);

    const [healthResult, treeResult, gitResult, workspaceResult, repositoriesResult, modelResult, skillResult, handoffResult] = results;
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
        setMessages(workspaceResult.value.recentAgentRuns.slice().reverse().flatMap((run, index) => {
          const runId = run.id ?? `restored-${index}`;
          return [
            ...(run.question ? [{
              id: `${runId}-question`,
              role: "user" as const,
              text: run.question,
            }] : []),
            {
              id: `${runId}-answer`,
              role: "assistant" as const,
              text: run.answer || run.summary || "Agent run completed.",
              plan: run.plan,
              telemetry: run.telemetry,
              framework: engineLabel(run.engine),
              model: run.model,
            },
          ];
        }));
      }
    }
    if (repositoriesResult.status === "fulfilled") {
      setRepositories(nextRepositories);
    }
    if (modelResult.status === "fulfilled") {
      const discovered = Array.from(new Set([
        modelResult.value.model,
        ...(modelResult.value.models ?? []),
      ].filter((value): value is string => Boolean(value))));
      const options = discovered.filter(
        (model) => modelResult.value.modelStatus?.[model] === "ready",
      );
      setModels(options);
      const catalog = modelResult.value.engines
        ? modelResult.value.engines
        : [{
          id: "openai-agents" as const,
          name: "OpenAI Agents SDK",
          status: "ready" as const,
          class: "agentic" as const,
          toolLoop: true,
          codingReady: true,
          source: "OpenAI",
          notes: "Contract v2 proposal and approval-bound tool path.",
        }];
      setEngines(catalog);
      const nextEngines = catalog.filter((engine) => engine.status === "ready" && engine.codingReady);
      setSelectedEngine((current) =>
        nextEngines.some((engine) => engine.id === current)
          ? current
          : nextEngines[0]?.id ?? "openai-agents",
      );
      const firstReady = options[0] ?? "";
      setSelectedModel((current) =>
        current && options.includes(current) ? current : firstReady,
      );
    }
    if (skillResult.status === "fulfilled") {
      const catalog = skillResult.value.catalog ?? [];
      setSkillCatalog(catalog);
      setSelectedSkills((current) =>
        current.filter((skillId) => catalog.some((skill) => skill.id === skillId)),
      );
    }
    if (handoffResult.status === "fulfilled") setHandoffs(handoffResult.value.handoffs ?? []);
    else setHandoffs([]);
  }, [companionUrl, messages.length, selectedTaskId, selectedWorkspaceId]);

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

  async function selectRepository(repositoryId: string) {
    if (repositoryId === selectedWorkspaceId) return;
    const repository = repositories.find((item) => item.id === repositoryId);
    if (!repository) return;
    setBusy(true);
    setError("");
    try {
      await readJson(
        await fetch(`${companionUrl}/workspace/select`, {
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
    setPendingContract(null);
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
        await fetch(`${companionUrl}/fs/read`, {
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

  async function collectRepositoryContext(message: string) {
    const textExtension = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|cs|cpp|c|h|hpp|rb|php|swift|sql|md|json|ya?ml|toml|ini|css|scss|html|sh|ps1)$/i;
    const normalizedMessage = message.toLowerCase();
    const preferredPaths = new Map([
      ["skills.md", 110],
      ["readme.md", 90],
      ["package.json", 80],
      ["compose.yaml", 75],
      ["docker-compose.yml", 75],
      ["app/api/agent/route.ts", 70],
      ["lib/agent-provider.ts", 65],
      ["lib/environment-store.ts", 60],
      ["langgraph-agent/graph.py", 60],
    ]);
    const manuallyAttached = contextFiles.slice(-8);
    const manualPaths = new Set(manuallyAttached.map((file) => file.path));
    // Ask the companion to search its server-side repository inventory first.
    // This avoids making the browser's currently visible file list the source
    // of truth for agent grounding.
    try {
      const response = await fetch(`${companionUrl}/context/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: message, maxFiles: 8, maxTokens: 12_000 }),
      });
      if (response.ok) {
        const data = await response.json() as { files?: Array<{ path: string; content: string }> };
        const serverFiles = (data.files ?? []).filter(
          (file) => typeof file?.path === "string" && typeof file?.content === "string" && !manualPaths.has(file.path),
        );
        if (serverFiles.length > 0) return [...manuallyAttached, ...serverFiles].slice(0, 8);
      }
    } catch {
      // Fall back to the already loaded tree when the companion is offline.
    }
    const candidates = allFiles
      .filter((file) => textExtension.test(file.path) && !manualPaths.has(file.path))
      .map((file) => {
        const path = file.path.toLowerCase();
        const basename = path.split("/").at(-1) ?? path;
        const preferredScore = preferredPaths.get(path) ?? preferredPaths.get(basename) ?? 0;
        const mentionedScore =
          (normalizedMessage.includes(path) ? 200 : 0) +
          (basename.length > 3 && normalizedMessage.includes(basename) ? 120 : 0);
        const keywordScore = normalizedMessage
          .split(/[^\p{L}\p{N}_.-]+/u)
          .filter((word) => word.length >= 4 && path.includes(word))
          .length * 15;
        return { path: file.path, score: mentionedScore + keywordScore + preferredScore };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
      .slice(0, Math.max(0, 8 - manuallyAttached.length));
    const snapshots = await Promise.all(candidates.map(async ({ path }) => {
      try {
        const response = await fetch(`${companionUrl}/fs/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        if (!response.ok) return null;
        const data = await response.json() as { content?: string };
        if (typeof data.content !== "string" || !data.content.trim()) return null;
        return { path, content: data.content.slice(0, 16_000) };
      } catch {
        return null;
      }
    }));
    let totalBytes = manuallyAttached.reduce(
      (total, file) => total + new TextEncoder().encode(file.content).byteLength,
      0,
    );
    return [
      ...manuallyAttached,
      ...snapshots.filter((snapshot): snapshot is { path: string; content: string } => {
        if (!snapshot) return false;
        const bytes = new TextEncoder().encode(snapshot.content).byteLength;
        if (totalBytes + bytes > 48_000) return false;
        totalBytes += bytes;
        return true;
      }),
    ].slice(0, 8);
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
      const workspaceContextFiles = await collectRepositoryContext(message);
      const data = await readJson<{
        output?: AgentProposal;
        agentContract?: AgentContract;
        model?: string;
        engine?: string;
        orchestration?: { checkpointId?: string; status?: string };
        telemetry?: AgentTelemetry;
      }>(
        await fetch("/api/agent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify({
            message,
            mode: agentMode,
            engine: selectedEngine,
            model: selectedModel,
            skills: selectedSkills.length ? selectedSkills : undefined,
            taskId: activeTask?.id,
            workspaceId: selectedWorkspaceId,
            idempotencyKey: key,
            workspaceFiles: workspaceContextFiles,
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
        ? recoverExplicitCommandBatch(message)
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
      const hasMutation = Boolean(
        proposalOutput.artifacts?.length || proposalOutput.execution || proposalOutput.executions?.length,
      );
      const contract = data.agentContract ?? null;
      setPendingContract(contract);
      setMessages((current) => [...current, {
        id: `${key}-response`,
        role: "assistant",
        text: `${proposalOutput.summary}${data.engine === "langgraph" && data.orchestration?.checkpointId ? `\n\nLangGraph checkpoint: ${data.orchestration.checkpointId.slice(0, 12)}` : ""}`,
        plan: proposalOutput.plan,
        telemetry: data.telemetry,
        framework: engineLabel(data.engine ?? selectedEngine),
        model: data.model ?? selectedModel,
      }]);
      if (agentMode === "agent" && hasMutation && !contract) {
        setError("The provider returned a mutation without a Contract v2 approval binding. Request it again before applying or running anything.");
      } else if (agentMode === "agent" && hasMutation) {
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

  async function runBenchmark() {
    const question = benchmarkPrompt.trim();
    const readyEngines = engines.filter((engine) => engine.status === "ready");
    if (!question || !selectedModel || !readyEngines.length || busy) return;
    setBusy(true);
    setError("");
    setBenchmarkResults([]);
    setBenchmarkContextPaths([]);
    const results: BenchmarkResult[] = [];
    try {
      const workspaceContextFiles = await collectRepositoryContext(question);
      setBenchmarkContextPaths(workspaceContextFiles.map((file) => file.path));
      for (const engine of readyEngines) {
        const key = uniqueKey(`benchmark-${engine.id}`);
        try {
          const data = await readJson<{
            output?: AgentProposal;
            model?: string;
            telemetry?: AgentTelemetry;
          }>(
            await fetch("/api/agent", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Idempotency-Key": key,
              },
              body: JSON.stringify({
                message: question,
                mode: "ask",
                engine: engine.id,
                model: selectedModel,
                skills: selectedSkills.length ? selectedSkills : undefined,
                workspaceId: selectedWorkspaceId,
                taskId: activeTask?.id,
                idempotencyKey: key,
                workspaceFiles: workspaceContextFiles,
                workspace: {
                  repository: health?.root ?? "Local workspace",
                  branch: health?.branch,
                  headSha: gitHead,
                },
              }),
            }),
          );
          results.push({
            engine: engine.id,
            engineName: engine.name,
            model: data.model ?? selectedModel,
            question,
            answer: data.output?.summary ?? "No answer returned.",
            ok: true,
            telemetry: data.telemetry ?? {
              durationMs: 0,
              tokenUsage: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              tools: [],
              auditLog: [],
            },
          });
        } catch (failure) {
          results.push({
            engine: engine.id,
            engineName: engine.name,
            model: selectedModel,
            question,
            answer: "",
            ok: false,
            error: failure instanceof Error ? failure.message : "Benchmark request failed.",
            telemetry: {
              durationMs: 0,
              tokenUsage: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              tools: [],
              auditLog: [],
            },
          });
        }
        setBenchmarkResults([...results]);
      }
      await refresh();
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
    if (!pendingContract) {
      setError("This mutation proposal is missing its Contract v2 approval binding. Request it again with an active task.");
      return;
    }
    if (!window.confirm(
      `Apply ${proposal.artifacts?.length ?? 0} reviewed file(s) to the local workspace${executions.length ? ` and run ${executions.length} reviewed command(s)` : ""}?`,
    )) return;
    setBusy(true);
    setError("");
    setExecutionResults([]);
    try {
      if (proposal.artifacts?.length) {
        await approvedCompanionAction(
          companionUrl,
          "fs.write",
          "/fs/write",
          {
            files: proposal.artifacts.map(({ path, content }) => ({ path, content })),
          },
          pendingContract.mutation,
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
          companionUrl,
          "terminal.execute-batch",
          "/terminal/execute-batch",
          { commands },
          pendingContract.mutation,
        );
        setExecutionResults(result.results);
      }
      setProposal(null);
      setPendingContract(null);
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
        companionUrl,
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

  async function inspectHandoff(handoff: HandoffRecord) {
    if (!handoffIdentity.trim()) {
      setError("Paste a short-lived signed handoff identity token before loading protected evidence.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({
        workspaceId: selectedWorkspaceId,
        taskId: handoff.taskId,
        details: "full",
      });
      const result = await readJson<{ handoffs?: HandoffDetailRecord[] }>(await fetch(`/api/handoffs?${query}`, {
        cache: "no-store",
        headers: { "X-Conductor-Identity": handoffIdentity.trim() },
      }));
      const detail = result.handoffs?.find((item) => item.id === handoff.id);
      if (!detail) throw new Error("Protected handoff evidence was not returned.");
      setHandoffDetails((current) => ({ ...current, [handoff.id]: detail }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Handoff evidence could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  async function mutateHandoff(
    handoff: HandoffRecord,
    action: "accept" | "approve" | "reject" | "retry" | "discard" | "publish",
  ) {
    if (!handoffIdentity.trim()) {
      setError("Paste the signed worker or human handoff identity token required for this action.");
      return;
    }
    const note = action === "reject" ? window.prompt("Reason for rejecting this handoff:")?.trim() : undefined;
    if (action === "reject" && !note) return;
    if (!window.confirm(`Record handoff action “${action}” for ${handoff.fromRole} → ${handoff.toRole}?`)) return;
    const idempotencyKey = uniqueKey(`handoff-${action}`);
    const body = action === "approve" || action === "reject"
      ? { action: "review", workspaceId: selectedWorkspaceId, handoffId: handoff.id, decision: action, evidenceDigest: handoff.evidenceDigest, ...(note ? { notes: note } : {}), idempotencyKey }
      : action === "retry" || action === "discard"
        ? { action: "resolve", workspaceId: selectedWorkspaceId, handoffId: handoff.id, resolution: action, idempotencyKey }
        : { action, workspaceId: selectedWorkspaceId, handoffId: handoff.id, idempotencyKey };
    setBusy(true);
    setError("");
    try {
      await readJson(await fetch("/api/handoffs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          "X-Conductor-Identity": handoffIdentity.trim(),
        },
        body: JSON.stringify(body),
      }));
      await refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Handoff action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="portal-shell">
      <header className="desktop-titlebar">
        <div className="desktop-brand" aria-label="Conductor">C</div>
        <nav aria-label="Application menu">
          <button type="button" onClick={() => void connectCurrentRepository()} disabled={busy || !companionReady}>File</button>
          <button type="button" onClick={() => document.querySelector<HTMLTextAreaElement>(".portal-composer textarea")?.focus()}>Edit</button>
          <button type="button" onClick={() => setWorkspaceOpen((open) => !open)}>View</button>
          <button type="button" onClick={() => window.alert("New task: Ctrl+N · Focus prompt: Ctrl+L · Send: Ctrl+Enter")}>Help</button>
        </nav>
        <div className="desktop-title">Conductor AI Environment</div>
      </header>

      <div className="portal-body">
      <nav className="activity-rail" aria-label="Primary tools">
        <button type="button" className="active" aria-label="Repositories" title="Repositories" onClick={() => setActiveTab("project")}>▱</button>
        <button type="button" aria-label="New Agent" title="New Agent" onClick={() => void createTask()} disabled={busy}>⌁</button>
        <button type="button" aria-label="Search repositories" title="Search" onClick={() => document.querySelector<HTMLInputElement>(".repository-filter")?.focus()}>⌕</button>
        <span />
        <button type="button" aria-label="Toggle repository files" title="Toggle repository files" onClick={() => setWorkspaceOpen((open) => !open)}>▤</button>
      </nav>

      <aside className="portal-sidebar" aria-label="Repository navigation">
        <div className="repository-sidebar-heading">
          <div className="portal-label">REPOSITORIES</div>
          <div>
            <button type="button" onClick={() => void connectCurrentRepository()} disabled={busy || !companionReady} aria-label="Connect current repository">▣</button>
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
            <button type="button" {...portalTabProps("chat")} className={activeTab === "chat" ? "active" : ""} onClick={() => setActiveTab("chat")}>◌ Chat</button>
            <button type="button" {...portalTabProps("git")} className={activeTab === "git" ? "active" : ""} onClick={() => setActiveTab("git")}>⑂ Git</button>
            <button type="button" {...portalTabProps("project")} className={activeTab === "project" ? "active" : ""} onClick={() => setActiveTab("project")}>▣ Project</button>
            <button type="button" {...portalTabProps("mcp")} className={activeTab === "mcp" ? "active" : ""} onClick={() => setActiveTab("mcp")}>◆ MCP</button>
            <button type="button" {...portalTabProps("automations")} className={activeTab === "automations" ? "active" : ""} onClick={() => setActiveTab("automations")}>◷ Automations</button>
            <button type="button" {...portalTabProps("benchmark")} className={activeTab === "benchmark" ? "active" : ""} onClick={() => setActiveTab("benchmark")}>◫ Benchmark</button>
          </div>
          <div className="header-status">
            <span className={workspaceRuntimeReady ? "status-ready" : "status-offline"} />
            {workspaceRuntimeReady ? `${health?.branch || "detached"} · ${gitHead || "no HEAD"}` : "Repository runtime unavailable"}
            <button type="button" className="refresh-button" onClick={() => void refresh()} disabled={busy}>↻</button>
          </div>
        </header>

        {error && <div className="portal-error" role="alert">{error}</div>}
        <div className="portal-content" id="portal-active-panel" role="tabpanel" aria-labelledby={`portal-tab-${activeTab}`}>
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
                        <div className="message-meta">
                          <span>{message.role}</span>
                          {message.role === "assistant" && message.framework && (
                            <span className="answer-runtime">
                              {message.framework}
                              {message.model ? ` · ${message.model}` : ""}
                            </span>
                          )}
                        </div>
                        <p>{message.text}</p>
                        {message.plan?.length ? <ol>{message.plan.map((step) => <li key={step}>{step}</li>)}</ol> : null}
                        {message.telemetry && (
                          <div className="message-telemetry">
                            <span>{message.telemetry.durationMs.toLocaleString()} ms</span>
                            <span>{message.telemetry.tokenUsage.totalTokens.toLocaleString()} tokens</span>
                            <span>{message.telemetry.tools.length} tool events</span>
                          </div>
                        )}
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
                    <div className="composer-toolbar-primary">
                      <button type="button" onClick={() => void attachFiles()} disabled={!workspaceRuntimeReady}>＋ Attach file</button>
                      <button type="button" className={agentMode === "ask" ? "selected" : ""} onClick={() => setAgentMode("ask")}>Ask</button>
                      <button type="button" className={agentMode === "agent" ? "selected" : ""} onClick={() => setAgentMode("agent")}>Agent</button>
                      <span className="context-count">{contextFiles.length} context file(s)</span>
                    </div>
                    <div className="composer-toolbar-secondary">
                      {engines.some((engine) => engine.status === "ready" && engine.codingReady) ? (
                        <select value={selectedEngine} onChange={(event) => setSelectedEngine(event.target.value as AgentEngine["id"])} aria-label="Select agent engine">
                          {engines.filter((engine) => engine.status === "ready" && engine.codingReady).map((engine) => (
                            <option key={engine.id} value={engine.id}>
                              {engine.name} · agentic · ready
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="context-count">No agentic engine is ready</span>
                      )}
                      <select
                        value={selectedSkills[0] ?? ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          setSelectedSkills(value ? [value] : []);
                        }}
                        aria-label="Select skill guide"
                      >
                        <option value="">Auto-match skills</option>
                        {skillCatalog.map((skill) => (
                          <option key={skill.id} value={skill.id}>
                            {skill.id}{skill.disableModelInvocation ? " · manual" : " · auto"}
                          </option>
                        ))}
                      </select>
                      <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} aria-label="Select model">
                        {!models.length && <option value="">No ready model</option>}
                        {models.map((model) => <option key={model} value={model}>{model} · ready</option>)}
                      </select>
                      <button className="send-message" type="submit" disabled={!prompt.trim() || busy || !selectedModel}>↑</button>
                    </div>
                  </div>
                </form>
              </>
            )}

            {activeTab !== "chat" && (
              <div className="panel-scroll">
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
                <p className="form-help">GitHub installation repositories are selected through the authenticated server-side GitHub App route. Repository creation, clone, and direct push are not browser or companion capabilities.</p>
                <section className="handoff-panel" aria-label="Role handoff workflow">
                  <div className="handoff-heading">
                    <div>
                      <h2>Role handoff workflow</h2>
                      <p>Planner → implementer → tester → reviewer; evidence is immutable and publication remains human-controlled.</p>
                    </div>
                    <button type="button" onClick={() => void refresh()} disabled={busy}>Refresh</button>
                  </div>
                  <label className="handoff-identity-field">
                    <span>Short-lived signed identity</span>
                    <input
                      type="password"
                      value={handoffIdentity}
                      onChange={(event) => setHandoffIdentity(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Paste worker or human handoff token"
                    />
                    <small>Held only in this page memory; never sent to the model or persisted by the browser.</small>
                  </label>
                  {handoffs.length ? (
                    <ol className="handoff-list">
                      {handoffs.map((handoff) => (
                        <li key={handoff.id} className={`handoff-item handoff-${handoff.status}`}>
                          <div>
                            <strong>{handoff.fromRole} → {handoff.toRole}</strong>
                            <span>{handoff.status}</span>
                          </div>
                          <small>submitted by {handoff.submittedBy ?? "signed identity (protected)"} · {new Date(handoff.createdAt).toLocaleString()}</small>
                          <code title={handoff.evidenceDigest}>evidence {handoff.evidenceDigest.slice(0, 12)}…</code>
                          <div className="handoff-actions">
                            <button type="button" onClick={() => void inspectHandoff(handoff)} disabled={busy || !handoffIdentity.trim()}>Inspect evidence</button>
                            {handoff.status === "pending" && <button type="button" onClick={() => void mutateHandoff(handoff, "accept")} disabled={busy || !handoffIdentity.trim()}>Accept</button>}
                            {handoff.status === "accepted" && handoff.toRole === "reviewer" && <>
                              <button type="button" onClick={() => void mutateHandoff(handoff, "approve")} disabled={busy || !handoffIdentity.trim()}>Approve</button>
                              <button type="button" className="danger" onClick={() => void mutateHandoff(handoff, "reject")} disabled={busy || !handoffIdentity.trim()}>Reject</button>
                            </>}
                            {handoff.status === "conflict" && <>
                              <button type="button" onClick={() => void mutateHandoff(handoff, "retry")} disabled={busy || !handoffIdentity.trim()}>Retry</button>
                              <button type="button" className="danger" onClick={() => void mutateHandoff(handoff, "discard")} disabled={busy || !handoffIdentity.trim()}>Discard</button>
                            </>}
                            {handoff.status === "approved" && <button type="button" onClick={() => void mutateHandoff(handoff, "publish")} disabled={busy || !handoffIdentity.trim()}>Authorize publication record</button>}
                          </div>
                          {handoffDetails[handoff.id] && <div className="handoff-evidence">
                            <strong>{handoffDetails[handoff.id].evidence.summary}</strong>
                            <small>snapshot {handoffDetails[handoff.id].context.snapshotId} · {handoffDetails[handoff.id].context.totalTokens} estimated tokens</small>
                            {handoffDetails[handoff.id].context.files.map((file) => <details key={file.path}>
                              <summary>{file.path}</summary>
                              <pre>{file.content}</pre>
                            </details>)}
                            {handoffDetails[handoff.id].evidence.checks.map((check) => <div className="handoff-check" key={`${check.command}-${check.exitCode}`}>
                              <code>{check.command}</code><span className={check.exitCode === 0 ? "passed" : "failed"}>exit {check.exitCode}</span>
                            </div>)}
                          </div>}
                        </li>
                      ))}
                    </ol>
                  ) : <p className="empty-copy">No role handoff has been recorded for this task.</p>}
                </section>
                {terminalOutput && <pre className="terminal-output">{terminalOutput}</pre>}
              </section>
            )}

            {activeTab === "mcp" && (
              <McpPermissionsPanel workspaceId={selectedWorkspaceId} />
            )}
            {activeTab === "automations" && <AutomationsPanel workspaceId={selectedWorkspaceId} identity={handoffIdentity} onIdentityChange={setHandoffIdentity} />}

            {activeTab === "benchmark" && (
              <section className="real-panel benchmark-panel">
                <div className="benchmark-heading">
                  <div>
                    <h1>Agent engine benchmark</h1>
                    <p>Send the same read-only question, model, context, and repository snapshot to every ready engine.</p>
                  </div>
                  <button type="button" onClick={() => void runBenchmark()} disabled={busy || !benchmarkPrompt.trim() || !selectedModel}>
                    {busy ? "Running…" : "Run comparison"}
                  </button>
                </div>
                <label className="benchmark-question">
                  <span>Test question</span>
                  <textarea value={benchmarkPrompt} onChange={(event) => setBenchmarkPrompt(event.target.value)} rows={4} />
                </label>
                <div className="benchmark-config">
                  <span>Model: <strong>{selectedModel || "not ready"}</strong></span>
                  <span>Context files: <strong>{benchmarkContextPaths.length || contextFiles.length}</strong></span>
                  <span>Ready engines: <strong>{engines.filter((engine) => engine.status === "ready").length}</strong></span>
                </div>
                {benchmarkContextPaths.length > 0 && (
                  <details className="benchmark-context">
                    <summary>Repository snapshot used by both engines ({benchmarkContextPaths.length} files)</summary>
                    <ul>{benchmarkContextPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
                  </details>
                )}
                {!benchmarkResults.length && (
                  <p className="empty-copy">Run a comparison to capture answers, token usage, response time, tool activity, and the audit trail.</p>
                )}
                <div className="benchmark-grid">
                  {benchmarkResults.map((result) => (
                    <article className={`benchmark-card ${result.ok ? "success" : "failure"}`} key={result.engine}>
                      <header>
                        <div>
                            <strong>{result.engineName}</strong>
                            <small>
                              {result.model} · {engines.find((engine) => engine.id === result.engine)?.source ?? "unknown source"}
                              {" · "}
                              {engines.find((engine) => engine.id === result.engine)?.class ?? "unknown"}
                            </small>
                        </div>
                        <span>{result.ok ? "Completed" : "Failed"}</span>
                      </header>
                      <dl className="benchmark-metrics">
                        <div><dt>Total response</dt><dd>{result.telemetry.durationMs.toLocaleString()} ms</dd></div>
                        <div><dt>Provider response</dt><dd>{(result.telemetry.providerDurationMs ?? 0).toLocaleString()} ms</dd></div>
                        <div><dt>Reported tokens</dt><dd>{result.telemetry.tokenUsage.totalTokens.toLocaleString()}</dd></div>
                        <div><dt>Input / output</dt><dd>{result.telemetry.tokenUsage.inputTokens.toLocaleString()} / {result.telemetry.tokenUsage.outputTokens.toLocaleString()}</dd></div>
                        <div><dt>Model requests</dt><dd>{result.telemetry.tokenUsage.requests}</dd></div>
                        <div><dt>Tool events</dt><dd>{result.telemetry.tools.length}</dd></div>
                      </dl>
                      <section>
                        <h2>Question</h2>
                        <p>{result.question}</p>
                      </section>
                      <section>
                        <h2>Answer</h2>
                        <p>{result.error || result.answer}</p>
                      </section>
                      <details>
                        <summary>Tools used ({result.telemetry.tools.length})</summary>
                        {result.telemetry.tools.length ? (
                          <ul>{result.telemetry.tools.map((tool, index) => <li key={`${tool.name}-${index}`}><code>{tool.name}</code> · {tool.status}</li>)}</ul>
                        ) : <p>No tools used.</p>}
                      </details>
                      <details>
                        <summary>Audit log ({result.telemetry.auditLog.length})</summary>
                        <ol className="audit-log">
                          {result.telemetry.auditLog.map((event, index) => (
                            <li key={`${event.stage}-${index}`}>
                              <time>{new Date(event.at).toLocaleTimeString()}</time>
                              <div><strong>{event.stage}</strong><span>{event.detail}</span></div>
                            </li>
                          ))}
                        </ol>
                      </details>
                    </article>
                  ))}
                </div>
                <section className="audit-history" aria-label="Recent audited Agent runs">
                  <div>
                    <h2>Recent audited runs</h2>
                    <span>{workspace.recentAgentRuns?.length ?? 0} stored</span>
                  </div>
                  {(workspace.recentAgentRuns ?? []).map((run) => (
                    <details key={run.id}>
                      <summary>
                        <strong>{run.engine || "legacy run"}</strong>
                        <span>{run.model || "unknown model"}</span>
                        <time>{run.createdAt ? new Date(run.createdAt).toLocaleString() : ""}</time>
                      </summary>
                      <div className="audit-history-body">
                        <section><h3>Question</h3><p>{run.question || "Question was not captured for this legacy run."}</p></section>
                        <section><h3>Answer</h3><p>{run.answer || run.summary || "No answer recorded."}</p></section>
                        <dl className="benchmark-metrics">
                          <div><dt>Total response</dt><dd>{run.telemetry?.durationMs.toLocaleString() ?? "—"} ms</dd></div>
                          <div><dt>Reported tokens</dt><dd>{run.telemetry?.tokenUsage.totalTokens.toLocaleString() ?? "—"}</dd></div>
                          <div><dt>Tools</dt><dd>{run.telemetry?.tools.length ?? 0}</dd></div>
                        </dl>
                        <details>
                          <summary>Tools used ({run.telemetry?.tools.length ?? 0})</summary>
                          {run.telemetry?.tools.length
                            ? <ul>{run.telemetry.tools.map((tool, index) => <li key={`${tool.name}-${index}`}><code>{tool.name}</code> · {tool.status}</li>)}</ul>
                            : <p>No tools used.</p>}
                        </details>
                        <details>
                          <summary>Audit log ({run.telemetry?.auditLog.length ?? 0})</summary>
                          <ol className="audit-log">
                            {(run.telemetry?.auditLog ?? []).map((event, index) => (
                              <li key={`${event.stage}-${index}`}>
                                <time>{new Date(event.at).toLocaleTimeString()}</time>
                                <div><strong>{event.stage}</strong><span>{event.detail}</span></div>
                              </li>
                            ))}
                          </ol>
                        </details>
                      </div>
                    </details>
                  ))}
                  {!workspace.recentAgentRuns?.length && <p className="empty-copy">No audited Agent run has been stored yet.</p>}
                </section>
              </section>
            )}
              </div>
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
      </div>
    </main>
  );
}
