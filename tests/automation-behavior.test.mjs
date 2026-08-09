import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import test from "node:test";

function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const file of ["0000_eager_vulcan.sql", "0001_sweet_deadpool.sql", "0002_empty_falcon.sql", "0003_watery_wong.sql", "0004_smiling_chat.sql", "0005_fair_psynapse.sql", "0006_cold_peter_quill.sql", "0007_steady_tomorrow_man.sql"]) {
    const migration = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) database.exec(statement);
  }
  return database;
}

function seedAutomation(database) {
  database.prepare("INSERT INTO workspaces (id, name, repository_name, repository_path, provider, default_branch, active_branch, base_sha, head_sha, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("workspace", "Workspace", "repo", "/workspace", "local", "main", "main", "a".repeat(40), "a".repeat(40), "ready", "2026-08-09T00:00:00Z", "2026-08-09T00:00:00Z");
  database.prepare("INSERT INTO automations (id, workspace_id, owner_id, name, enabled, trigger_json, agent_profile_id, agent_profile_version, skill_profile_id, skill_profile_version, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, 1, NULL, ?, ?)")
    .run("automation", "workspace", "human:owner", "Test", '{"type":"manual"}', "agent", "skills", "2026-08-09T00:00:00Z", "2026-08-09T00:00:00Z");
}

test("automation run reservation is idempotent and an expired materializer lease is recoverable", () => {
  const database = migratedDatabase();
  seedAutomation(database);
  const insert = database.prepare("INSERT OR IGNORE INTO automation_runs (id, automation_id, workspace_id, owner_id, idempotency_key, status, snapshot_id, task_id, lease_owner, lease_expires_at, created_at, updated_at) VALUES (?, 'automation', 'workspace', 'human:owner', 'same-key', 'materializing', ?, ?, ?, ?, ?, ?)");
  const first = insert.run("run-1", "snapshot-1", "task-1", "worker-a", "2026-08-09T00:00:01Z", "2026-08-09T00:00:00Z", "2026-08-09T00:00:00Z");
  const duplicate = insert.run("run-2", "snapshot-2", "task-2", "worker-b", "2026-08-09T00:00:02Z", "2026-08-09T00:00:00Z", "2026-08-09T00:00:00Z");
  assert.equal(first.changes, 1);
  assert.equal(duplicate.changes, 0);
  const reclaimed = database.prepare("UPDATE automation_runs SET lease_owner = ?, lease_expires_at = ? WHERE id = ? AND status = 'materializing' AND lease_expires_at <= ?").run("worker-c", "2026-08-09T00:02:00Z", "run-1", "2026-08-09T00:01:00Z");
  assert.equal(reclaimed.changes, 1);
  assert.equal(database.prepare("SELECT lease_owner FROM automation_runs WHERE id = 'run-1'").get().lease_owner, "worker-c");
});

test("automation profiles, audit events, and snapshot manifests reject update and delete", () => {
  const database = migratedDatabase();
  seedAutomation(database);
  database.prepare("INSERT INTO automation_profiles (id, workspace_id, owner_id, kind, version, name, definition_json, created_at) VALUES ('agent', 'workspace', 'human:owner', 'agent', 1, 'Agent', '{}', ?)").run("2026-08-09T00:00:00Z");
  database.prepare("INSERT INTO automation_runs (id, automation_id, workspace_id, owner_id, idempotency_key, status, snapshot_id, created_at, updated_at) VALUES ('run-1', 'automation', 'workspace', 'human:owner', 'key', 'queued', 'snapshot-1', ?, ?)").run("2026-08-09T00:00:00Z", "2026-08-09T00:00:00Z");
  database.prepare("INSERT INTO automation_snapshots (id, run_id, workspace_id, manifest_json, created_at) VALUES ('snapshot-1', 'run-1', 'workspace', '{}', ?)").run("2026-08-09T00:00:00Z");
  database.prepare("INSERT INTO automation_events (event_id, run_id, workspace_id, type, actor_id, detail_json, created_at) VALUES ('event-1', 'run-1', 'workspace', 'automation.run.materialized', 'human:owner', '{}', ?)").run("2026-08-09T00:00:00Z");
  assert.throws(() => database.exec("UPDATE automation_events SET detail_json='{}' WHERE event_id='event-1'"), /append-only/);
  assert.throws(() => database.exec("DELETE FROM automation_events WHERE event_id='event-1'"), /append-only/);
  assert.throws(() => database.exec("UPDATE automation_profiles SET name='Changed' WHERE id='agent'"), /immutable/);
  assert.throws(() => database.exec("DELETE FROM automation_profiles WHERE id='agent'"), /immutable/);
  assert.throws(() => database.exec("UPDATE automation_snapshots SET manifest_json='{}' WHERE id='snapshot-1'"), /immutable/);
  assert.throws(() => database.exec("DELETE FROM automation_snapshots WHERE id='snapshot-1'"), /immutable/);
});

test("an expired scheduled materialization remains recoverable after the schedule advances", () => {
  const database = migratedDatabase();
  seedAutomation(database);
  database.prepare("UPDATE automations SET trigger_json = ?, next_run_at = ? WHERE id = 'automation'")
    .run('{"type":"schedule","every":"*/15 * * * *"}', "2026-08-09T00:15:00Z");
  database.prepare("INSERT INTO automation_runs (id, automation_id, workspace_id, owner_id, idempotency_key, status, snapshot_id, lease_owner, lease_expires_at, created_at, updated_at) VALUES ('run-stale', 'automation', 'workspace', 'human:owner', 'schedule:2026-08-09T00:00:00Z', 'materializing', 'snapshot-stale', 'dead-worker', '2026-08-09T00:00:30Z', ?, ?)")
    .run("2026-08-09T00:00:00Z", "2026-08-09T00:00:00Z");
  const recoverable = database.prepare(
    `SELECT a.id, r.idempotency_key AS recovery_key
     FROM automation_runs r JOIN automations a ON a.id = r.automation_id
     WHERE r.status = 'materializing' AND r.idempotency_key LIKE 'schedule:%'
       AND (r.lease_expires_at IS NULL OR r.lease_expires_at <= ?)`
  ).get("2026-08-09T00:01:00Z");
  assert.equal(recoverable.id, "automation");
  assert.equal(recoverable.recovery_key, "schedule:2026-08-09T00:00:00Z");
});

test("a cancellation that loses a race to completion cannot mutate its task or approval", () => {
  const database = migratedDatabase();
  seedAutomation(database);
  database.prepare("INSERT INTO tasks (id, workspace_id, title, goal, status, branch, base_sha, created_by_idempotency_key) VALUES ('task-complete', 'workspace', 'Task', 'Goal', 'completed', 'automation/task', ?, 'key-task')")
    .run("a".repeat(40));
  database.prepare("INSERT INTO approvals (id, workspace_id, task_id, action, summary, risk_level, status, action_digest, requested_by, expires_at) VALUES ('approval-pending', 'workspace', 'task-complete', 'agent.apply', 'Apply', 'R1', 'pending', 'digest', 'agent', ?)")
    .run("2026-08-09T01:00:00Z");
  database.prepare("INSERT INTO automation_runs (id, automation_id, workspace_id, owner_id, idempotency_key, status, snapshot_id, task_id, created_at, updated_at) VALUES ('run-complete', 'automation', 'workspace', 'human:owner', 'key-complete', 'completed', 'snapshot-complete', 'task-complete', ?, ?)")
    .run("2026-08-09T00:00:00Z", "2026-08-09T00:00:00Z");
  const cancelledAt = "2026-08-09T00:02:00Z";
  const cancelled = database.prepare("UPDATE automation_runs SET cancel_requested = 1, status = 'cancelled', updated_at = ? WHERE id = ? AND status NOT IN ('completed', 'cancelled')")
    .run(cancelledAt, "run-complete");
  const approval = database.prepare("UPDATE approvals SET status = 'withdrawn' WHERE task_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM automation_runs WHERE id = ? AND status = 'cancelled' AND updated_at = ?)")
    .run("task-complete", "run-complete", cancelledAt);
  const task = database.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ? AND status NOT IN ('completed', 'cancelled') AND EXISTS (SELECT 1 FROM automation_runs WHERE id = ? AND status = 'cancelled' AND updated_at = ?)")
    .run("task-complete", "run-complete", cancelledAt);
  assert.equal(cancelled.changes, 0);
  assert.equal(approval.changes, 0);
  assert.equal(task.changes, 0);
  assert.equal(database.prepare("SELECT status FROM tasks WHERE id='task-complete'").get().status, "completed");
  assert.equal(database.prepare("SELECT status FROM approvals WHERE id='approval-pending'").get().status, "pending");
});
