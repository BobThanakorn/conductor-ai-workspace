import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { workspaceActionSchema } from "../lib/api-contract.ts";

test("task queue actions validate worker leases and checkpoints", () => {
  assert.deepEqual(workspaceActionSchema.parse({
    action: "claim",
    taskId: "task_1",
    workerId: "terra",
    leaseMinutes: 45,
  }), {
    action: "claim",
    taskId: "task_1",
    workerId: "terra",
    leaseMinutes: 45,
  });
  const heartbeat = workspaceActionSchema.parse({
    action: "heartbeat",
    taskId: "task_1",
    workerId: "terra",
    checkpointId: "checkpoint_1",
  });
  assert.equal("checkpointId" in heartbeat ? heartbeat.checkpointId : undefined, "checkpoint_1");
  assert.throws(() => workspaceActionSchema.parse({
    action: "claim",
    taskId: "task_1",
    workerId: "terra",
    leaseMinutes: 0,
  }));
});

test("task creation persists dependency edges and retry policy", () => {
  const parsed = workspaceActionSchema.parse({
    action: "create_task",
    title: "Dependent task",
    goal: "Wait for the prerequisite",
    dependsOn: ["task_parent"],
    maxAttempts: 4,
  });
  assert.deepEqual("dependsOn" in parsed ? parsed.dependsOn : undefined, ["task_parent"]);
  assert.equal("maxAttempts" in parsed ? parsed.maxAttempts : undefined, 4);
  assert.equal(workspaceActionSchema.parse({ action: "fail", taskId: "task_1", reason: "provider timeout" }).action, "fail");
});

test("workspace API exposes a durable queue view and lease actions", async () => {
  const [route, store] = await Promise.all([
    readFile(new URL("../app/api/workspace/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/environment-store.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /view === "queue"/);
  assert.match(route, /loadTaskQueue/);
  assert.match(store, /lease_owner/);
  assert.match(store, /task\.claimed/);
  assert.match(store, /attempt_count/);
  assert.match(store, /checkpoint_id/);
  assert.match(store, /task_dependencies/);
  assert.match(store, /retry_after/);
  assert.match(store, /task_retry_backoff/);
});
