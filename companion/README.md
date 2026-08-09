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
- `GET /worktrees` (task lifecycle and recovery state)

Approval-gated endpoints:

- `POST /fs/write`, `POST /fs/delete`
- `POST /terminal/execute`
- `POST /git/commit`
- `POST /worktrees/prepare`, `POST /worktrees/release`

The lifecycle endpoints require an approval token issued for the exact
`worktree.prepare` or `worktree.release` payload; a missing or reused token is
rejected before any Git worktree operation runs.

When a Contract v2 mutation includes `contractMutation.taskId`, the companion
creates (or resumes) a dedicated branch and Git worktree below
`.conductor/worktrees/<taskId>` before the approval request is issued. The
approved filesystem, terminal, and Git commit action
is then resolved against that task root; a task cannot select another task's
root or escape the selected repository. Worktree metadata is kept in the
ignored `.conductor/worktrees.json` file. A clean release removes the checkout
but keeps the branch and lifecycle record. A forced release first captures the
status, binary patch, and bounded untracked files under
`.conductor/evidence/<taskId>-<capture>` so evidence is not silently discarded.
Mutations without a task binding retain the existing selected-repository root.

Terminal execution is an approval-bound executable allowlist, not a shell.
It permits only bounded local `node`, `npm`, `python3`, `tsc`, and read-only
`git` invocations; shells, environment wrappers, aliases, remote Git, and
network/package launchers are rejected. Commands are rejected on a direct host run unless
`CONDUCTOR_ALLOW_HOST_EXECUTION=true`. Docker Compose sets
`CONDUCTOR_EXECUTION_MODE=container`, mounts only `WORKSPACE_PATH`, runs without
root privileges, and applies resource limits. HTTP/MCP transport is not treated
as authorization; approval integrity and process isolation are enforced here.

Remote publication and clone are not companion capabilities. The old `/git/action`,
`/git/clone`, and `/provider/github/*` paths return `410`, shared GitHub tokens
are not loaded, and terminal `git push`/`send-pack` commands are rejected. A protected pull
request may be merged only by the server-side GitHub App publication route
after a signed human identity, a short-lived payload-bound permit, and fresh
provider policy/check/review validation.
