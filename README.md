# Conductor

Conductor is a security-first AI engineering workspace for planning, reviewing,
and shipping work with coding agents. This repository implements the first
production-shaped vertical slice of the approved AI Environment System.

## Included in this slice

- IDE-style workspace with files, diffs, task state, agent activity, context,
  approvals, Git review, and validation output.
- Durable D1-backed tasks, approvals, and append-only task events.
- An OpenAI Agents SDK boundary with a deterministic demo mode when no API key
  is configured.
- Exact approval and idempotency contracts for persistent actions.
- A local-companion foundation for workspace path validation and typed,
  read-only Git operations.
- Cloudflare/Vinext deployment through OpenAI Sites.

This is intentionally not the final autonomous system. Write-capable local
tools, sandbox transport, remote Git publication, credential injection, and
third-party MCP installation remain gated roadmap phases.

## Run locally

```bash
npm install
npm run dev
```

The application runs in demo-agent mode by default. To enable the live agent,
copy `.env.example` to an ignored local environment file and provide an OpenAI
API key. Never commit credentials.

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
- Repository and tool content is treated as untrusted evidence.
- The companion foundation has no generic-shell or write capability.
- Hidden chain-of-thought is not requested or persisted.

See [`companion/README.md`](companion/README.md) for the local execution-plane
boundary once that optional component is enabled.
