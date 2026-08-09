import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

const [command, databaseArgument, targetArgument] = process.argv.slice(2);
const root = resolve(process.cwd());

if (!command || !databaseArgument) {
  throw new Error("usage: operations-recovery.mjs backup|restore|drill|replay <sqlite-path> [backup-path]");
}

function safeDatabasePath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const path = resolve(root, value);
  const repositoryRelative = relative(root, path).replaceAll("\\", "/");
  const validDirectory = /^(?:artifacts|data)\//.test(repositoryRelative);
  const validSuffix = /\.(?:sqlite|db)(?:\.(?:backup|rollback|restore\.tmp|recovery\.json))?$/.test(repositoryRelative);
  if (!validDirectory || !validSuffix) {
    throw new Error("database paths must be .sqlite/.db below artifacts/ or data/");
  }

  let cursor = path;
  while (cursor !== root) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error("symlink paths are rejected");
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("database path escaped the repository root");
    cursor = parent;
  }
  return path;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function verify(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get().integrity_check;
    const tables = database.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const schema = JSON.stringify(tables);
    const logical = JSON.stringify(tables.map(({ name }) => {
      const escaped = String(name).replaceAll('"', '""');
      return [name, database.prepare(`SELECT * FROM "${escaped}" ORDER BY rowid`).all()];
    }));
    const marker = database.prepare("SELECT max(created_at) AS marker FROM operations_audit").get().marker ?? null;
    if (integrity !== "ok") throw new Error(`integrity failed: ${integrity}`);
    return {
      integrity,
      schemaDigest: digest(schema),
      dataDigest: digest(logical),
      marker,
    };
  } finally {
    database.close();
  }
}

function snapshot(source, target) {
  if (source === target) throw new Error("source and target must differ");
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { force: true });
  const database = new DatabaseSync(source);
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.prepare("VACUUM INTO ?").run(target);
  } finally {
    database.close();
  }
}

const databasePath = safeDatabasePath(databaseArgument, "database path");

if (command === "replay") {
  rmSync(databasePath, { force: true });
  const database = new DatabaseSync(databasePath);
  try {
    for (const file of readdirSync(resolve(root, "drizzle")).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      const migration = readFileSync(resolve(root, "drizzle", file), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) database.exec(statement);
      }
    }
  } finally {
    database.close();
  }
  console.log(JSON.stringify({ command, ...verify(databasePath) }));
} else if (command === "backup") {
  const target = safeDatabasePath(targetArgument, "backup path");
  snapshot(databasePath, target);
  console.log(JSON.stringify({ command, ...verify(target) }));
} else if (command === "restore") {
  const backup = safeDatabasePath(targetArgument, "backup path");
  if (!existsSync(backup)) throw new Error("backup is missing");
  const checked = verify(backup);
  const temporary = safeDatabasePath(`${databasePath}.restore.tmp`, "temporary restore path");
  const rollback = safeDatabasePath(`${databasePath}.rollback`, "rollback path");
  snapshot(backup, temporary);
  if (verify(temporary).dataDigest !== checked.dataDigest) throw new Error("temporary restore digest mismatch");
  if (existsSync(databasePath)) snapshot(databasePath, rollback);
  try {
    rmSync(databasePath, { force: true });
    renameSync(temporary, databasePath);
  } catch (error) {
    rmSync(databasePath, { force: true });
    if (existsSync(rollback)) renameSync(rollback, databasePath);
    throw error;
  }
  console.log(JSON.stringify({ command, ...verify(databasePath), rollback, rollbackProof: existsSync(rollback) }));
} else if (command === "drill") {
  const backup = safeDatabasePath(targetArgument ?? `${databasePath}.backup`, "backup path");
  const rollback = safeDatabasePath(`${databasePath}.rollback`, "rollback path");
  const temporary = safeDatabasePath(`${databasePath}.restore.tmp`, "temporary restore path");
  const started = Date.now();
  const before = verify(databasePath);
  snapshot(databasePath, backup);
  snapshot(databasePath, rollback);
  try {
    rmSync(databasePath, { force: true });
    snapshot(backup, temporary);
    renameSync(temporary, databasePath);
  } catch (error) {
    rmSync(databasePath, { force: true });
    if (existsSync(rollback)) snapshot(rollback, databasePath);
    throw error;
  }
  const after = verify(databasePath);
  const report = {
    command,
    rpoSeconds: before.marker === after.marker ? 0 : null,
    rtoMs: Date.now() - started,
    before,
    after,
    rollback,
    rollbackProof: verify(rollback).dataDigest === before.dataDigest,
    restoredProof: before.dataDigest === after.dataDigest && before.schemaDigest === after.schemaDigest,
  };
  if (!report.rollbackProof || !report.restoredProof) throw new Error("restore digest mismatch");
  writeFileSync(`${databasePath}.recovery.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} else {
  throw new Error("unknown recovery command");
}
