# Conductor Roadmap Orchestrator

This directory is the operational handoff layer used by the primary Codex
session while continuing development of Conductor. It routes implementation
work through Luna and reserves Terra/Codex for independent review and
orchestration; it is not a claim that the product runtime can launch those
models by itself.

`roadmap.json` is the source of truth for phases, dependencies, scope,
acceptance criteria, required checks and worker profiles. `state.json` is local
runtime state and is ignored by Git.

## Safety model

- A claimed task is a lease, not permission to publish or broaden scope.
- Model output and submitted evidence are untrusted until independent review.
- A worker cannot approve its own submission.
- Completion requires evidence for every required check with exit code `0`.
- The state writer uses an exclusive lock and atomic rename.
- Commit, push, merge, releases and secret changes require a separate explicit
  human instruction; the roadmap cannot grant those permissions.
- `Luna` is a configurable worker profile, not a claim that a provider model
  with that ID is currently deployed. Bind and smoke-test the real model before
  allowing dispatch. The roadmap policy makes Luna the only worker allowed to
  claim implementation tasks.

## Normal workflow

Validate and inspect the plan:

```powershell
npm run orchestrator:validate
npm run orchestrator:status
```

Ask for the best eligible task without changing state:

```powershell
npm run orchestrator -- next --worker luna
```

Claim it and use the returned `handoff` object as the worker's complete task
envelope:

```powershell
npm run orchestrator -- claim P1-T1 --worker luna --lease-minutes 45
```

For long work, renew the lease before it expires:

```powershell
npm run orchestrator -- heartbeat P1-T1 --worker luna
```

Create evidence by copying `evidence.example.json`, listing every changed file,
and recording the exact required checks. Then submit it:

```powershell
npm run orchestrator -- submit P1-T1 --worker luna --evidence .\evidence-P1-T1.json
```

An independent worker reviews the diff and reruns risk-proportionate checks:

```powershell
npm run orchestrator -- review P1-T1 --reviewer terra --decision approve --notes "Contract and fail-closed tests verified"
```

Rejecting returns the task to `pending`:

```powershell
npm run orchestrator -- review P1-T1 --reviewer terra --decision reject --notes "Approval hash does not cover every execution"
```

Failure and manual release are explicit:

```powershell
npm run orchestrator -- fail P1-T1 --worker luna --reason "Provider fixture unavailable" --blocked true
npm run orchestrator -- release P1-T1 --worker luna
```

## Codex worker operating loop

1. Run `next`; do not cherry-pick an attractive blocked task.
2. Claim exactly one task and inspect current repository state.
3. Work only inside `scope`; report any necessary expansion rather than silently
   taking it.
4. Preserve unrelated dirty files and never copy secrets into logs or prompts.
5. Renew the lease when needed.
6. Run every required check and record exact results.
7. Submit evidence. Do not mark your own work complete.
8. The reviewer inspects actual changes, reruns checks where needed, and then
   approves or rejects.

## Roadmap order

1. Unified coding-agent contract and six full adapters.
2. Durable multi-agent queue and per-task worktrees.
3. MCP registry, lifecycle and permission UI.
4. Repository-scale context and provenance.
5. GitHub App and controlled automations.
6. Production images, recovery and release evidence.

This ordering keeps reliable single-agent execution ahead of multi-agent
autonomy and keeps local, reviewed changes ahead of remote publication.
