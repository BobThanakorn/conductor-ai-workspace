import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

function createDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      checkpoint_id TEXT
    );
    CREATE TABLE idempotency_keys (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    );
    CREATE TABLE task_dependencies (workspace_id TEXT, task_id TEXT, depends_on_task_id TEXT);
  `);
  return db;
}

test("expired ISO leases are rejected by SQLite datetime comparison and recoverable", () => {
  const db = createDb();
  const expired = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 120_000).toISOString();
  db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)").run("expired", "workspace", "planning", "terra", expired, 1, null);
  db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)").run("active", "workspace", "planning", "terra", future, 1, null);
  const heartbeat = db.prepare(`UPDATE tasks SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND datetime(lease_expires_at) > datetime('now')`);
  assert.equal(heartbeat.run(future, "expired", "terra").changes, 0);
  assert.equal(heartbeat.run(future, "active", "terra").changes, 1);
  const reclaim = db.prepare(`UPDATE tasks SET lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1 WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at IS NULL OR datetime(lease_expires_at) <= datetime('now') OR lease_owner = ?)`);
  assert.equal(reclaim.run("luna", future, "expired", "luna").changes, 1);
  assert.equal(db.prepare("SELECT lease_owner, attempt_count FROM tasks WHERE id = ?").get("expired").lease_owner, "luna");
});

test("dependency edges block claims until prerequisite completes and retry backoff expires", () => {
  const db = createDb();
  db.exec("ALTER TABLE tasks ADD COLUMN retry_after TEXT; ALTER TABLE tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;");
  const future = new Date(Date.now() + 120_000).toISOString();
  db.prepare("INSERT INTO tasks(id, workspace_id, status, attempt_count, max_attempts) VALUES (?, ?, ?, ?, ?)").run("parent", "workspace", "planning", 0, 3);
  db.prepare("INSERT INTO tasks(id, workspace_id, status, attempt_count, max_attempts, retry_after) VALUES (?, ?, ?, ?, ?, ?)").run("child", "workspace", "failed", 1, 3, future);
  db.prepare("INSERT INTO task_dependencies VALUES (?, ?, ?)").run("workspace", "child", "parent");
  const blocked = db.prepare(`SELECT 1 FROM task_dependencies d JOIN tasks dependency ON dependency.id = d.depends_on_task_id WHERE d.task_id = ? AND dependency.status NOT IN ('completed')`).get("child");
  assert.ok(blocked);
  db.prepare("UPDATE tasks SET status = 'completed' WHERE id = 'parent'").run();
  const backoff = db.prepare("SELECT 1 FROM tasks WHERE id = ? AND datetime(retry_after) > datetime('now')").get("child");
  assert.ok(backoff);
});

test("workspace scoping prevents a worker from updating another workspace task", () => {
  const db = createDb();
  const future = new Date(Date.now() + 120_000).toISOString();
  db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)").run("same-id", "workspace-a", "planning", "terra", future, 1, null);
  const heartbeat = db.prepare(`UPDATE tasks SET checkpoint_id = ? WHERE id = ? AND workspace_id = ? AND lease_owner = ? AND datetime(lease_expires_at) > datetime('now')`);
  assert.equal(heartbeat.run("cp-1", "same-id", "workspace-b", "terra").changes, 0);
  assert.equal(db.prepare("SELECT checkpoint_id FROM tasks WHERE id = ?").get("same-id").checkpoint_id, null);
});

test("duplicate delivery is idempotent at the durable key boundary", () => {
  const db = createDb();
  const insert = db.prepare("INSERT INTO idempotency_keys(scope, key, status) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO NOTHING");
  assert.equal(insert.run("workspace:one", "req_1", "completed").changes, 1);
  assert.equal(insert.run("workspace:one", "req_1", "completed").changes, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get().count, 1);
});
