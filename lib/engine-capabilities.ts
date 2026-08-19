export type EngineClass = "agentic" | "ask-only" | "retrieval";
export type EngineHealth = "ready" | "configured" | "unavailable";

export type EngineCapability = {
  id:
    | "conductor-native"
    | "openai-agents"
    | "langgraph"
    | "pydantic-ai"
    | "crewai"
    | "microsoft-agent-framework"
    | "llamaindex"
    | "haystack"
    | "semantic-kernel"
    | "openhands";
  name: string;
  class: EngineClass;
  toolLoop: boolean;
  notes: string;
};

const CAPABILITIES: Record<EngineCapability["id"], Omit<EngineCapability, "id">> = {
  "conductor-native": {
    name: "Conductor Native · Tesseract",
    class: "agentic",
    toolLoop: true,
    notes: "Framework-free read-only planning loop with Contract v2 approval.",
  },
  "openai-agents": {
    name: "OpenAI Agents SDK",
    class: "agentic",
    toolLoop: true,
    notes: "Contract v2 proposal and approval-bound tool path.",
  },
  langgraph: {
    name: "LangChain + LangGraph",
    class: "agentic",
    toolLoop: true,
    notes: "Checkpointed graph with a separate execution companion.",
  },
  "pydantic-ai": {
    name: "PydanticAI",
    class: "agentic",
    toolLoop: true,
    notes: "PydanticAI loop can call the read-only companion fs.read tool; mutations remain Contract v2 proposals.",
  },
  crewai: {
    name: "CrewAI",
    class: "ask-only",
    toolLoop: false,
    notes: "Single Crew kickoff with delegation disabled; no coding tool loop yet.",
  },
  "microsoft-agent-framework": {
    name: "Microsoft Agent Framework",
    class: "ask-only",
    toolLoop: false,
    notes: "One-shot provider response wrapper.",
  },
  llamaindex: {
    name: "LlamaIndex",
    class: "retrieval",
    toolLoop: false,
    notes: "Context and retrieval comparison harness, not a coding loop.",
  },
  haystack: {
    name: "Haystack",
    class: "retrieval",
    toolLoop: false,
    notes: "Retrieval pipeline comparison harness, not a coding loop.",
  },
  "semantic-kernel": {
    name: "Semantic Kernel",
    class: "ask-only",
    toolLoop: false,
    notes: "Single plugin/provider response wrapper.",
  },
  openhands: {
    name: "OpenHands SWE Harness",
    class: "agentic",
    toolLoop: true,
    notes: "Isolated task-worktree planner that emits Contract v2 mutations; no direct workspace writes.",
  },
};

/** Temporarily hidden from portal/benchmark until live verification passes. */
export const ENGINE_ROLLOUT_BLOCKLIST = new Set<EngineCapability["id"]>([
  "conductor-native",
  "pydantic-ai",
  "openhands",
]);

export function resolveEngineHealth(
  id: EngineCapability["id"],
  health: EngineHealth,
): EngineHealth {
  return ENGINE_ROLLOUT_BLOCKLIST.has(id) ? "unavailable" : health;
}

export function engineCapability(
  id: EngineCapability["id"],
  status: EngineHealth,
): EngineCapability & { status: EngineHealth; codingReady: boolean } {
  const capability = CAPABILITIES[id];
  const resolvedStatus = resolveEngineHealth(id, status);
  return {
    id,
    ...capability,
    status: resolvedStatus,
    codingReady: resolvedStatus === "ready" && capability.class === "agentic" && capability.toolLoop,
  };
}
