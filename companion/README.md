# Conductor execution companion

The companion is the repository execution plane. It exposes filesystem,
terminal, Git, and provider operations while keeping model credentials out of
browser code.

Every mutation uses a two-step approval protocol:

1. `POST /approvals/request` records the exact action payload and digest.
2. An explicit UI action calls `POST /approvals/approve` for that digest.
3. The short-lived token is accepted once and only for the canonical payload
   that was reviewed.

Read endpoints:

- `GET /health`, `GET /fs/tree`, `POST /fs/read`
- `GET /git/status`, `POST /git/diff`

Approval-gated endpoints:

- `POST /fs/write`, `POST /fs/delete`
- `POST /terminal/execute`
- `POST /git/commit`, `POST /git/action`
- `POST /provider/github/pull-request`

Generic terminal commands are rejected on a direct host run unless
`CONDUCTOR_ALLOW_HOST_EXECUTION=true`. Docker Compose sets
`CONDUCTOR_EXECUTION_MODE=container`, mounts only `WORKSPACE_PATH`, runs without
root privileges, and applies resource limits. HTTP/MCP transport is not treated
as authorization; approval integrity and process isolation are enforced here.
