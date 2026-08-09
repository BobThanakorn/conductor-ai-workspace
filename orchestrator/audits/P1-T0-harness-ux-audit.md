# P1-T0 — Harness and comparison UX audit

Date: 2026-08-03

This is an evidence-backed inventory of the current code paths. It does not
change runtime behavior and must not be interpreted as a readiness claim for a
provider that has not passed a live smoke test.

## Engine truth table

| Engine | Current code path | Current behavior | State classification | Gap |
|---|---|---|---|---|
| OpenAI Agents SDK | `app/api/agent/route.ts` → `runLiveAgent` | Structured `AgentProposal`; artifacts and bounded execution; MCP read-only filter; persisted telemetry and approval | Ready only when provider and companion health are live | Requires Contract v2 adapter for shared tools |
| LangChain + LangGraph | `app/api/agent/route.ts` → `runLangGraphAgent` → `langgraph-agent/app.py` | Structured proposal, checkpoint, shared telemetry; separate companion | Ready only when `agent-langgraph/health` and provider smoke test pass | Python wire schema still needs Contract v2 normalization |
| PydanticAI | `compose.harnesses.yaml` → `agent-harnesses/common/app.py` | Native provider call returns text answer and token metrics | Configured/ready health is not coding-agent readiness | API wraps it as R0 answer; no artifacts, execution, tool calls or approval |
| CrewAI | same common service, `run_crewai` | Native Crew execution returns text answer and metrics | Configured/ready health is not coding-agent readiness | Same read-only adapter gap; Crew delegation is disabled |
| Microsoft Agent Framework | same common service, `run_microsoft_agent_framework` | Native provider call returns text answer and metrics | Configured/ready health is not coding-agent readiness | No shared proposal or tool contract |
| LlamaIndex | same common service, `run_llamaindex` | PromptTemplate + provider text answer | Configured/ready health is not coding-agent readiness | No index/tool/action contract; context is bounded files only |
| Haystack | same common service, `run_haystack` | One-component pipeline returns text answer | Configured/ready health is not coding-agent readiness | No coding proposal or execution contract |
| Semantic Kernel | same common service, `run_semantic_kernel` | One plugin invokes provider and returns text answer | Configured/ready health is not coding-agent readiness | No tool permission or proposal contract |

Evidence paths: `lib/external-harness.ts`, `agent-harnesses/common/app.py`,
`app/api/agent/route.ts`, `compose.harnesses.yaml`.

## User-flow inventory

1. Portal loads `/api/models`; only model IDs whose `modelStatus` is `ready`
   are placed into the model selector (`app/portal/page.tsx`).
2. Engine health is used to mark an engine ready, but health only confirms the
   service/module path. It does not prove the provider model is authorized or
   that a coding proposal can be generated.
3. Chat sends repository context selected by `collectRepositoryContext`.
   Context is limited to eight files and a 48,000-byte client-side budget.
4. OpenAI/LangGraph responses can produce an approval card. External harness
   responses are converted to a synthetic R0 `read_only_answer`, so the UI
   correctly has no Apply & Run action for those engines.
5. Benchmark runs the same Ask question sequentially across engines marked
   ready and displays answer, model, latency, tokens, tools and audit data.
6. Apply & Run uses the browser to request a fresh companion approval for file
   writes and terminal execution. The external harnesses never reach this path.

## Classification that must appear in future UI

- **Ready**: service health, configured model, direct provider smoke test and
  the engine's Contract v2 proposal test all pass.
- **Configured**: credentials/service are present but live inference or contract
  capability has not been verified.
- **Unavailable**: health, provider, dependency or contract request failed.
- **Ask-only**: engine can answer and report telemetry but cannot produce a
  reviewed coding proposal or execute tools.

## Contract input for the next tasks

- P1-T2 must expose one normalized tool adapter to OpenAI, LangGraph and the
  six external engines; the adapter must return tool events without granting
  the model authorization.
- P1-T3 must replace the synthetic R0 wrapper in `app/api/agent/route.ts` with
  Contract v2 proposal responses, or explicitly keep an engine Ask-only and
  label it as such.
- P1-T4 must show readiness state and the Ask-only limitation before a user
  selects an engine; it must not show a disabled Apply button as if the engine
  were broken.
- Benchmark comparisons must separate answer quality from coding capability.

## Acceptance result

The inventory distinguishes current mock/configured/ready behavior and links
each claim to a source path. No production runtime behavior was changed by this
audit.
