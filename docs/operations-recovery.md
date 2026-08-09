# Operations and recovery

`GET /api/operations?workspaceId=workspace_local` requires the same signed server principal as other owner-scoped APIs. It returns only liveness, readiness, aggregate per-minute counters, and an `X-Conductor-Trace-Id`; it never returns prompts, provider payloads, credentials, or audit detail.

Agent and automation mutations reserve a durable D1/SQLite minute bucket atomically before execution. `CONDUCTOR_AGENT_QUOTA_PER_MINUTE` and `CONDUCTOR_AUTOMATION_QUOTA_PER_MINUTE` are bounded positive integers; malformed limits fail closed.
Every allowed or denied reservation is written to the append-only operations audit with a bounded trace ID. Agent and automation responses echo that ID in `X-Conductor-Trace-Id` so an operator can correlate an API request without storing prompts, provider payloads, or credentials.

For a local SQLite/D1 export, use an explicit database path only:

```powershell
node scripts/operations-recovery.mjs replay .\artifacts\clean.sqlite
node scripts/operations-recovery.mjs backup .\data\d1.sqlite .\artifacts\d1.sqlite.backup
node scripts/operations-recovery.mjs drill .\data\d1.sqlite .\artifacts\d1.sqlite.backup
node scripts/operations-recovery.mjs restore .\data\d1.sqlite .\artifacts\d1.sqlite.backup
```

The drill records measured RPO/RTO, SQLite integrity, schema digest, data digest, and a rollback-copy proof. Restore is staged into a temporary database, verified before replacement, and retains the pre-restore database as `.rollback`. Recovery commands reject paths outside `artifacts/` or `data/` and reject symlink targets. They do not contact a provider or cloud D1. Production D1 exports and retention must be scheduled by the platform operator; this repository cannot authenticate to or mutate an operator account.

Release checklist: run migration replay, restore drill, `npm test`, `npm run typecheck`, `npm run lint`, Compose config, and strict container evidence. Then write `orchestrator/worker-evidence-P6-T2.json` and run `node scripts/release-gate.mjs`. The gate rejects missing/incomplete evidence and emits `artifacts/release-evidence.json`; it neither publishes nor signs anything.
