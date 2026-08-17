# Conductor AI Environment System — Development Handoff

Last updated: 2026-08-10 (Asia/Bangkok)

## Stop state

Work was intentionally stopped at the user's request. No Docker build, Docker Scout scan, test runner, or release command from this handoff is still running. No commit, push, merge, image publication, signing, deployment, or provider-side mutation was performed.

The worktree is intentionally dirty and contains the accumulated project work plus user files. Do not reset, clean, or overwrite unrelated changes.

## Orchestrator state

`npm run orchestrator:status` currently reports:

- 14 roadmap tasks completed.
- `P6-T2 Operations, recovery and release gate` is the only unfinished task.
- P6-T2 was implemented and submitted by worker profile `luna`, then independently approved by `codex`.
- The roadmap now reports all 15 tasks completed.

## Completed system capabilities

### Agent frameworks and shared contract

Eight framework adapters are implemented behind the shared Agent Contract v2:

1. OpenAI Agents SDK
2. LangChain + LangGraph
3. PydanticAI
4. CrewAI
5. Microsoft Agent Framework
6. LlamaIndex
7. Haystack
8. Semantic Kernel

The contract supports repository-grounded messages, multiple proposed files, bounded command batches, normalized tool events, token/latency telemetry, explicit provider errors, and payload-bound approvals. Only runtime-ready models are exposed by the model API/UI.

### Coding workspace and execution

- Real repository file listing, context attachment, code proposal, approval, apply, and bounded execution paths.
- Execution results remain visible in the UI with stdout, stderr, exit code, status, and duration.
- Mutating operations require approval bound to the exact workspace snapshot, artifacts, tools, and commands.
- Per-task Git worktrees, durable leases, retries, cancellation, checkpoints, and idempotency.
- Same-origin companion proxy with a strict allowlist; legacy direct publication paths are retired.

### GitHub and publication security

- GitHub App installation-scoped authentication, repository selection, webhook verification, checks/reviews pagination, protected-branch rules, publication permits, and merge reconciliation.
- Direct push to protected/default branches and legacy PAT-based companion publication are blocked.
- Real provider smoke against a disposable protected GitHub repository still requires operator-supplied GitHub App credentials and a disposable test repository; no provider mutation was attempted during this work.

### MCP control center

- Durable MCP registry, connect/disconnect lifecycle, capability discovery, health, revocation, and provenance labels.
- Default-deny workspace/agent policy, immediate revocation, side-effect blocking, server revision checks, secret checks, and append-only audit events.
- Real API-backed MCP permissions UI with risk labels and policy history.

### Repository context

- Incremental symbol-aware repository index, secret/generated-file exclusions, redaction, snapshot/file/line/symbol provenance, hybrid retrieval, and token budgeting.

### Automations

- Owner-scoped immutable agent/skill profile versions.
- Manual, schedule, webhook, and allowlisted command triggers.
- Durable runs, unique immutable snapshots, leases, stale schedule recovery, cancellation, replay, pause/resume, and append-only events.
- Automation runs can create proposals, but cannot auto-approve file writes, execution, Git publication, or merge.

### Production packaging

- Versioned minimal, full, and benchmark Compose profiles.
- Nine production images, all configured non-root.
- Digest-pinned base images, immutable Debian snapshot packages, complete hashed Python dependency locks, runtime-only secrets, fresh-machine smoke, SPDX SBOM, and SARIF vulnerability evidence.
- P6-T1 passed independent review before P6-T2 source changes.

## P6-T2 work already implemented

The unfinished P6-T2 slice already includes:

- `GET /api/operations` with signed-principal authentication, liveness/readiness, aggregate quota metrics, no-store response, and bounded `X-Conductor-Trace-Id`.
- Durable per-minute agent and automation quota buckets.
- Quota limits from `CONDUCTOR_AGENT_QUOTA_PER_MINUTE` and `CONDUCTOR_AUTOMATION_QUOTA_PER_MINUTE`, bounded to positive integers up to 10,000 and failing closed when malformed.
- Append-only operations audit records for allowed and denied quota reservations and metrics reads; audit detail excludes prompts, provider payloads, credentials, and command arguments.
- Agent and automation responses echo the trace ID.
- Drizzle migration `0008_perpetual_stone_men.sql` for operations quota/audit tables plus immutable audit triggers.
- Recovery CLI in `scripts/operations-recovery.mjs` for migration replay, backup, restore, and measured restore drill.
- Recovery paths restricted to `.sqlite`/`.db` under `artifacts/` or `data/`; symlink paths are rejected.
- Restore stages and verifies a temporary copy, retains the pre-restore database as `.rollback`, and restores rollback on replacement failure.
- Release gate in `scripts/release-gate.mjs` that fails closed on missing task evidence, incomplete container evidence, source/image mismatch, failed checks, invalid integrity, non-zero RPO, missing rollback proof, or schema/data digest drift.
- Operator runbook in `docs/operations-recovery.md`.
- Dedicated behavioral tests in `tests/operations.test.mjs`.

## Verified checks at stop time

All commands below completed successfully after the final P6-T2 source changes and before the last image build:

- `npm run typecheck` — exit 0.
- `npm run lint` — exit 0.
- `npm run db:generate` — exit 0, no schema drift; 22 tables detected.
- `docker compose config` — exit 0.
- `node --experimental-strip-types --test tests/operations.test.mjs` — 4/4 passed.
- `npm test` — production build passed; application tests 121 passed, 0 failed, 1 opt-in live-harness test skipped; companion tests 18/18 passed.
- `npm run operations:replay` — clean migration replay passed with SQLite integrity `ok`.
- `npm run operations:drill` — RPO 0 seconds, RTO 41 ms, integrity `ok`, schema digest matched, data digest matched, restore proof true, rollback proof true.
- `git diff --check` — exit 0; only line-ending warnings were reported by Git.

Recovery evidence is in `artifacts/operations-clean.sqlite.recovery.json`.

## Image and evidence state at stop time

The final root image build completed before the interruption:

- Image: `conductor-ai-workspace:0.1.0`
- Current image ID: `sha256:57bad8e610711c7a4df0364a847b83e7da69e33f1d935581d5679ae7e121ad03`
- Host source digest before this handoff file was added: `ce74f7dd81c306dfb3c8a8b5034b3b4973bb76875fbf09aa69f3883ef33c5b89`
- Embedded image source digest before this handoff file was added: the same `ce74f7dd81c306dfb3c8a8b5034b3b4973bb76875fbf09aa69f3883ef33c5b89`

The root image rebuild completed, but the interrupted command did **not** refresh its Docker Scout artifacts. `artifacts/container-evidence/summary.json` still points at the preceding root image `sha256:cc0b809...`. Also, adding this handoff file changes the host source digest. Therefore the current container evidence must be treated as stale and the release gate must not be run or claimed passing yet.

## Exact remaining work for P6-T2

1. Recompute the source digest after this handoff file and any final documentation-only changes.
2. Rebuild only `conductor-ai-workspace:0.1.0` so `/app/.conductor-source-digest` matches the final host digest.
3. Refresh only the root image inspect/history/SPDX/SARIF evidence, then run the strict nine-image aggregate check.
4. Recreate the web service from the final root image with temporary local test values for the signing secret and low quota limit.
5. Perform a live authenticated `/api/operations` smoke:
   - unauthenticated request is rejected;
   - authenticated request returns liveness/readiness and echoes the trace header;
   - permitted agent/automation requests create append-only quota audit entries;
   - quota exhaustion returns HTTP 429 and records a denied audit event;
   - serialized responses and audit detail contain no credentials, prompts, provider payloads, or command arguments.
6. Remove the temporary test secrets and recreate the normal service configuration.
7. Write `orchestrator/worker-evidence-P6-T2.json` with exact commands, exit codes, runtime evidence, RPO/RTO, source digest, and current image ID.
8. Run `npm run release:gate`; verify `artifacts/release-evidence.json` is produced and source/image/evidence digests match.
9. Submit P6-T2 through the orchestrator.
10. Run an independent review with a reviewer other than the implementer. Only after approval should the roadmap report 15/15 completed.

## Safe resume commands

Run from the repository root in PowerShell. Do not run these concurrently with another Docker build or Docker Scout process.

```powershell
npm run orchestrator:status
npm run typecheck
npm run lint
npm run db:generate
npm test
docker compose config

npm run operations:replay
# Insert a current audit marker into artifacts/operations-clean.sqlite before the drill.
npm run operations:drill

$env:CONDUCTOR_IMAGE='conductor-ai-workspace:0.1.0'
docker compose --profile minimal build web
pwsh -NoProfile -File scripts/container-evidence.ps1 -Images conductor-ai-workspace:0.1.0
pwsh -NoProfile -File scripts/container-evidence.ps1 -AggregateOnly
```

After the live smoke and evidence file are complete:

```powershell
npm run release:gate
npm run orchestrator -- submit P6-T2 --worker luna --evidence orchestrator/worker-evidence-P6-T2.json
```

An independent reviewer must then inspect the evidence and use the orchestrator review command. The implementer must not approve its own task.

## Secret handling

- No API key, GitHub token, private key, webhook secret, signing secret, or provider credential is included in this handoff.
- Keep all credentials in the ignored local `.env` or runtime secret store; never bake them into images or copy them into audit/model context.
- Any credential previously pasted into chat should be rotated by its owner before production use.

## Important evidence and source files

- `orchestrator/roadmap.json`
- `orchestrator/worker-evidence-P6-T1.json`
- `orchestrator/reviewer-evidence-P6-T1.json`
- `artifacts/container-evidence/summary.json` — currently stale for the rebuilt root image; do not use as final P6-T2 proof.
- `artifacts/operations-clean.sqlite.recovery.json`
- `app/api/operations/route.ts`
- `lib/operations.ts`
- `scripts/operations-recovery.mjs`
- `scripts/release-gate.mjs`
- `scripts/container-evidence.ps1`
- `tests/operations.test.mjs`
- `docs/operations-recovery.md`

## Publication boundary

Completion of local tests and release evidence does not authorize commit, push, merge, image publication, deployment, GitHub repository mutation, or secret changes. Those actions still require explicit human approval.
