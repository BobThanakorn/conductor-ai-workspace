# Codex Development Orchestrator

This repository is operated by Codex as the primary development orchestrator.
The application runtime's agents are not authorized to manage the repository
roadmap. Codex owns sequencing, delegation, verification and user handoff.

## Mission

Continue building the Conductor AI Environment System from the tracked roadmap
in `orchestrator/roadmap.json`. Preserve real behavior over UI claims: a feature
is complete only after the provider/companion path, tests and relevant live
smoke checks provide evidence.

## Codex operating loop

For every development turn, Codex must:

1. Read `orchestrator/roadmap.json` and run `npm run orchestrator:status`.
2. Inspect the current worktree and preserve unrelated user changes.
3. Select the highest-priority eligible task whose dependencies are complete.
4. Claim it with the orchestrator before editing. The claim is a lease and does
   not grant permission to publish, commit, push, merge or change secrets.
5. Delegate bounded work to a worker only when the task has a clear scope:
   - Terra: backend, architecture, security, Docker, integration and contract work.
   - Luna: frontend, UX, accessibility, test review and documentation work.
   - These are profiles, not proof that a provider/model is available. Verify the
     actual model endpoint before dispatching provider work.
6. Give the worker only the generated handoff envelope, relevant files, and
   explicit stop conditions. Do not paste the entire repository by default.
7. Review the worker's diff and rerun required checks independently. Never let a
   worker approve its own task.
8. Submit machine-readable evidence, then approve or reject through the CLI.
9. Update the user with completed, partial, blocked and next-task status. Do not
   claim a feature is ready because a button rendered or a model was listed.

## Delegation contract

Worker instructions must include:

- task ID and objective;
- allowed scope and files;
- acceptance criteria;
- exact required checks;
- security and publication stop conditions;
- expected evidence file.

Workers must not silently expand scope, use hidden credentials, persist
chain-of-thought, or execute remote publication. If a dependency or provider is
missing, they must report `blocked` with evidence rather than inventing output.

## Commands

```powershell
npm run orchestrator:validate
npm run orchestrator:status
npm run orchestrator -- next --worker terra
npm run orchestrator -- next --worker luna
npm run orchestrator -- claim <task-id> --worker <worker-id>
npm run orchestrator -- heartbeat <task-id> --worker <worker-id>
npm run orchestrator -- submit <task-id> --worker <worker-id> --evidence <file>
npm run orchestrator -- review <task-id> --reviewer <worker-id> --decision approve|reject --notes <text>
```

## Completion gate

Codex may call a task completed only when:

- all dependencies are complete;
- changed files stay within the declared scope or scope expansion is recorded;
- every required check has exit code `0`;
- runtime/provider behavior is tested when the task changes an integration;
- security boundaries and approval behavior are verified;
- independent review is recorded;
- no unrelated user change was overwritten.

The orchestrator state is local and ignored by Git. The roadmap and this file
are the durable instructions for future Codex sessions.
