import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRepositoryIndex,
  chunkRepositoryFile,
  retrieveRepositoryContext,
  shouldIndexRepositoryPath,
  updateRepositoryIndex,
} from "../lib/repository-index.ts";

test("repository index excludes secrets and generated/dependency paths", () => {
  assert.equal(shouldIndexRepositoryPath(".env.local").ok, false);
  assert.equal(shouldIndexRepositoryPath("node_modules/pkg/index.js").ok, false);
  assert.equal(shouldIndexRepositoryPath("dist/app.js").ok, false);
  assert.equal(shouldIndexRepositoryPath("src/main.ts").ok, true);
  const index = buildRepositoryIndex([
    { path: ".env.local", content: "TOKEN=secret" },
    { path: "src/main.ts", content: "export function calculateTotal(value: number) { return value + 1; }" },
  ], "snap_1");
  assert.equal(index.files, 1);
  assert.equal(index.excluded[0]?.reason, "secret_file");
});

test("chunks carry snapshot, file hash, line range and symbol provenance", () => {
  const chunks = chunkRepositoryFile(
    { path: "src/service.ts", content: "export function answer() {\n  return 'ok';\n}\n" },
    "snap_abc",
    { maxChars: 500 },
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.snapshotId, "snap_abc");
  assert.equal(chunks[0]?.path, "src/service.ts");
  assert.deepEqual(chunks[0]?.symbols, ["answer"]);
  assert.equal(chunks[0]?.startLine, 1);
  assert.match(chunks[0]?.id ?? "", /snap_abc:src\/service\.ts:/);
});

test("retrieval prioritizes path and symbol matches and respects token budget", () => {
  const index = buildRepositoryIndex([
    { path: "src/billing/service.ts", content: "export function calculateInvoiceTotal() { return 42; }\n" },
    { path: "src/profile/service.ts", content: "export function updateProfile() { return true; }\n" },
    { path: "README.md", content: "General project documentation.\n" },
  ], "snap_2", { maxChars: 500 });
  const result = retrieveRepositoryContext(index, "calculateInvoiceTotal billing", { maxFiles: 1, maxTokens: 256 });
  assert.deepEqual(result.manifest.selectedFiles, ["src/billing/service.ts"]);
  assert.equal(result.manifest.snapshotId, "snap_2");
  assert.ok(result.manifest.estimatedTokens <= 256);
  assert.match(result.files[0]?.content ?? "", /context lines/);
});

test("retrieval token budget includes provenance wrapper overhead", () => {
  const index = buildRepositoryIndex([
    { path: "src/large.ts", content: "x".repeat(4_000) },
  ], "snap_large", { maxChars: 4_000 });
  const result = retrieveRepositoryContext(index, "large", { maxFiles: 1, maxTokens: 256 });
  assert.ok(result.manifest.estimatedTokens <= 256);
  assert.ok(Math.ceil((result.files[0]?.content.length ?? 0) / 4) <= 256);
});

test("redacts secrets before indexing and retrieval", () => {
  const index = buildRepositoryIndex([
    { path: "src/config.ts", content: "const token = super-secret-value;\n" },
  ], "snap_3");
  const result = retrieveRepositoryContext(index, "config token");
  assert.doesNotMatch(result.files[0]?.content ?? "", /super-secret-value/);
});

test("incremental indexing reuses unchanged chunks and refreshes snapshot provenance", () => {
  const first = buildRepositoryIndex([
    { path: "src/a.ts", content: "export const a = 1;" },
    { path: "src/b.ts", content: "export const b = 2;" },
  ], "snap_old");
  const second = updateRepositoryIndex(first, [
    { path: "src/a.ts", content: "export const a = 1;" },
    { path: "src/b.ts", content: "export const b = 3;" },
  ], "snap_new");
  const a = second.chunks.find((chunk) => chunk.path === "src/a.ts");
  const b = second.chunks.find((chunk) => chunk.path === "src/b.ts");
  assert.equal(a?.snapshotId, "snap_new");
  assert.equal(b?.snapshotId, "snap_new");
  assert.match(b?.content ?? "", /b = 3/);
});
