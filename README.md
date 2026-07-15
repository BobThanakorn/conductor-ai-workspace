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
- Exact approval and idempotency contracts for persistent actions.
- A local-companion foundation for workspace path validation and typed,
  read-only Git operations, with runtime tests for traversal and output limits.
- Cloudflare/Vinext deployment through OpenAI Sites.

This is intentionally not the final autonomous system. Write-capable local
tools, sandbox transport, remote Git publication, credential injection, and
third-party MCP installation remain gated roadmap phases.

## Run locally

```bash
npm install
npm run dev
```

The application runs in demo-agent mode by default. To enable the preferred Azure AI Foundry agent, set these server-side values (the key must never be placed in client code):

```bash
AZURE_AI_FOUNDRY_ENDPOINT=https://ai-environment-resource.services.ai.azure.com
AZURE_AI_FOUNDRY_API_KEY=replace-with-your-key
AZURE_AI_FOUNDRY_MODEL=gpt-5.1-codex-mini
```

Conductor normalizes the endpoint to Azure Foundry's OpenAI-compatible `/openai/v1` route and records each successful run as `azure`. It retains the deterministic demo response if the key is absent or the configured provider is unavailable. `OPENAI_API_KEY` remains an optional legacy fallback and is used only when the Azure key is absent.

Copy `.env.example` to an ignored local environment file and provide the Azure
API key (or the optional fallback key). Never commit credentials.

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
- Approval decisions are bound to task state and idempotency keys.
- Recording an approval never executes a command; actual execution remains a
  separately bound companion capability.
- Repository and tool content is treated as untrusted evidence.
- The companion foundation has no generic-shell or write capability.
- Hidden chain-of-thought is not requested or persisted.

See [`companion/README.md`](companion/README.md) for the local execution-plane
boundary once that optional component is enabled.
