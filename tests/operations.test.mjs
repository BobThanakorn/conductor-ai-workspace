import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  ensureOperationsSchema,
  quotaLimit,
  reserveQuota,
  traceId,
} from "../lib/operations.ts";

function d1(database) {
  return {
    prepare(sql) {
      const statement = (bindings = []) => ({
        bind(...next) { return statement(next); },
        async first() { return database.prepare(sql).get(...bindings) ?? null; },
        async run() {
          const result = database.prepare(sql).run(...bindings);
          return { success: true, meta: { changes: result.changes } };
        },
      });
      return statement();
    },
  };
}

function removeDatabase(path) {
  for (const suffix of ["", "-shm", "-wal", ".backup", ".rollback", ".restore.tmp", ".recovery.json"]) {
    rmSync(`${path}${suffix}`, { force: true, recursive: true });
  }
}

test("quota reservations are atomic, bounded, traced, and append-only audited", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const database = d1(sqlite);
  await ensureOperationsSchema(database);
  const now = new Date("2026-08-10T01:02:30.000Z");
  const common = { workspaceId: "workspace", actorId: "human:operator", traceId: "trace_1234567890abcd", bucket: "agent", limit: 2, now };

  assert.equal((await reserveQuota(database, common)).used, 1);
  assert.equal((await reserveQuota(database, common)).used, 2);
  await assert.rejects(() => reserveQuota(database, common), (error) => error?.code === "operations_quota_exhausted" && error?.status === 429);

  assert.equal(sqlite.prepare("SELECT used FROM operations_quota").get().used, 2);
  assert.deepEqual(
    sqlite.prepare("SELECT event_type FROM operations_audit ORDER BY created_at, rowid").all().map((row) => row.event_type),
    ["operations.quota.reserved", "operations.quota.reserved", "operations.quota.denied"],
  );
  assert.throws(() => sqlite.exec("UPDATE operations_audit SET actor_id='tampered'"), /append-only/);
  assert.throws(() => sqlite.exec("DELETE FROM operations_audit"), /append-only/);
  sqlite.close();
});

test("quota configuration and incoming trace IDs fail closed", () => {
  assert.equal(quotaLimit(undefined, 60), 60);
  assert.equal(quotaLimit("25", 60), 25);
  for (const value of ["0", "1.5", "10001", "not-a-number"]) {
    assert.throws(() => quotaLimit(value, 60), (error) => error?.code === "operations_quota_invalid");
  }
  const accepted = traceId(new Request("http://localhost", { headers: { "x-conductor-trace-id": "trace_1234567890abcd" } }));
  const replaced = traceId(new Request("http://localhost", { headers: { "x-conductor-trace-id": "bad value" } }));
  assert.equal(accepted, "trace_1234567890abcd");
  assert.match(replaced, /^[0-9a-f-]{36}$/);
});

test("migration replay and recovery drill prove integrity, RPO, RTO, restore, and rollback", () => {
  const databasePath = resolve("artifacts", `operations-test-${randomUUID()}.sqlite`);
  const backupPath = `${databasePath}.backup`;
  mkdirSync(resolve("artifacts"), { recursive: true });
  try {
    const replay = JSON.parse(execFileSync(process.execPath, ["scripts/operations-recovery.mjs", "replay", databasePath], { encoding: "utf8" }));
    assert.equal(replay.integrity, "ok");
    const database = new DatabaseSync(databasePath);
    database.prepare("INSERT INTO operations_audit (id,workspace_id,actor_id,event_type,trace_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)")
      .run("event-before", "workspace", "human:operator", "operations.test", "trace_1234567890abcd", "{}", "2026-08-10T01:00:00.000Z");
    assert.throws(() => database.exec("UPDATE operations_audit SET detail_json='{}'"), /append-only/);
    database.close();

    const drill = JSON.parse(execFileSync(process.execPath, ["scripts/operations-recovery.mjs", "drill", databasePath, backupPath], { encoding: "utf8" }));
    assert.equal(drill.rpoSeconds, 0);
    assert.ok(Number.isFinite(drill.rtoMs) && drill.rtoMs >= 0);
    assert.equal(drill.before.integrity, "ok");
    assert.equal(drill.after.integrity, "ok");
    assert.equal(drill.before.schemaDigest, drill.after.schemaDigest);
    assert.equal(drill.before.dataDigest, drill.after.dataDigest);
    assert.equal(drill.restoredProof, true);
    assert.equal(drill.rollbackProof, true);
    assert.equal(existsSync(`${databasePath}.rollback`), true);

    const changed = new DatabaseSync(databasePath);
    changed.prepare("INSERT INTO operations_audit (id,workspace_id,actor_id,event_type,trace_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)")
      .run("event-after", "workspace", "human:operator", "operations.test", "trace_1234567890abcd", "{}", "2026-08-10T01:01:00.000Z");
    changed.close();
    const restored = JSON.parse(execFileSync(process.execPath, ["scripts/operations-recovery.mjs", "restore", databasePath, backupPath], { encoding: "utf8" }));
    assert.equal(restored.integrity, "ok");
    assert.equal(restored.rollbackProof, true);
    const verified = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM operations_audit WHERE id='event-after'").get().count, 0);
    verified.close();
  } finally {
    removeDatabase(databasePath);
  }
});

test("recovery paths and release evidence fail closed", () => {
  const packagePath = resolve("package.json");
  const before = createHash("sha256").update(readFileSync(packagePath)).digest("hex");
  const unsafe = spawnSync(process.execPath, ["scripts/operations-recovery.mjs", "replay", packagePath], { encoding: "utf8" });
  assert.notEqual(unsafe.status, 0);
  assert.match(`${unsafe.stdout}${unsafe.stderr}`, /below artifacts\/ or data/);
  assert.equal(createHash("sha256").update(readFileSync(packagePath)).digest("hex"), before);

  const emptyRoot = resolve("artifacts", `release-gate-empty-${randomUUID()}`);
  mkdirSync(emptyRoot, { recursive: true });
  try {
    const release = spawnSync(process.execPath, [resolve("scripts/release-gate.mjs")], { cwd: emptyRoot, encoding: "utf8" });
    assert.notEqual(release.status, 0);
    assert.match(`${release.stdout}${release.stderr}`, /release gate missing evidence/);
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});
