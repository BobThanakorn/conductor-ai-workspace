# Conductor

Conductor is a security-first AI engineering workspace for planning, reviewing,
and shipping work with coding agents. This repository implements the first
production-shaped vertical slice of the approved AI Environment System.

## Included in this slice

- IDE-style workspace with files, diffs, task state, agent activity, context,
  approvals, Git review, and validation output.
- Durable D1-backed tasks, approvals, and append-only task events.
- Cursor-based incremental task-event synchronization for the workspace UI.
- An OpenAI Agents SDK boundary with a deterministic demo mode when no API key
  is configured, plus structured proposal normalization that redacts
  sensitive-looking output and raises side-effect proposals to human approval.
- Approval-gated Python file proposals: inspect complete `.py` drafts, approve
  them into a device-local browser workspace, run the selected entrypoint, and
  read stdout, stderr, exit status, and duration in the built-in Terminal.
- A one-shot Pyodide Web Worker execution sandbox with no host filesystem,
  disabled network bridges, standard-library-only code, strict size/output
  ceilings, and a hard 8-second code-execution timeout.
- Exact approval and idempotency contracts for persistent actions.
- A local-companion foundation for workspace path validation, typed Git reads,
  and approval-triggered local commit creation.
- Cloudflare/Vinext deployment through OpenAI Sites.

This is intentionally not the final autonomous system. Python files created by
the interface live in that browser's isolated workspace; they do not mutate the
host repository or become Git commits. Write-capable host tools, sandbox
transport, remote Git publication, credential injection, and third-party MCP
installation remain gated roadmap phases.

## Run locally

```bash
npm install
npm run dev
```

To let the Git review panel talk to the real local repository, keep this bridge
running in a second terminal from the same repository:

```bash
npm run companion:git
```

When the bridge is running, the UI reads real `git status` and `git diff` data,
then the reviewed commit button creates a local `git add` plus `git commit` for
the selected repository files. Push remains deliberately unavailable from the
browser UI.

The application runs in demo-agent mode by default. To enable the preferred Azure AI Foundry agent, set these server-side values (the key must never be placed in client code):

```bash
AZURE_AI_FOUNDRY_ENDPOINT=https://ai-environment-resource.services.ai.azure.com
AZURE_AI_FOUNDRY_API_KEY=replace-with-your-key
AZURE_AI_FOUNDRY_MODEL=gpt-5.1-codex-mini
```

Conductor normalizes the endpoint to Azure Foundry's OpenAI-compatible `/openai/v1` route and records each successful run as `azure`. It retains the deterministic demo response if the key is absent or the configured provider is unavailable. `OPENAI_API_KEY` remains an optional legacy fallback and is used only when the Azure key is absent.

Copy `.env.example` to an ignored local environment file and provide the Azure
API key (or the optional fallback key). Never commit credentials.

## Try the Coding Agent

Enter this in the prompt box at the bottom of the workspace:

```text
สร้างไฟล์ hello.py ให้พิมพ์ Hello from Python แล้วรันและแสดงผลลัพธ์
```

Conductor shows the complete draft before doing anything. Select a proposed
file to inspect it, then choose **Approve, create & run**. The first run loads
the browser Python runtime; subsequent output appears in **Terminal**. Use
**Run again** to execute the approved browser-workspace files again. A later
prompt can name an existing `.py` file to revise it because approved files are
sent back to the agent as bounded, untrusted workspace context.

## Verification

```bash
npm run typecheck
npm run lint
npm test
```

`npm test` performs a deployment build before checking the rendered product
surface.

## Security posture

- Model output is treated as a proposal, never authorization.
- The browser never receives model or provider credentials.
- Python drafts require an explicit review-and-approve action before they are
  saved or executed.
- Each Python execution gets a fresh one-shot Web Worker and in-memory
  filesystem. Network/host-storage bridges and package installation are
  disabled, and the worker is terminated after success, failure, or timeout.
- Approval decisions are bound to task state and idempotency keys.
- Repository approval records do not execute arbitrary host commands. The
  optional local Git companion exposes bounded status, diff, and commit
  endpoints only; push is not exposed.
- Repository and tool content is treated as untrusted evidence.
- The companion foundation has no generic-shell capability.
- Hidden chain-of-thought is not requested or persisted.

See [`companion/README.md`](companion/README.md) for the local execution-plane
boundary once that optional component is enabled.
