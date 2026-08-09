import { readFile } from "node:fs/promises";

import { createHandoffIdentityToken, type HandoffPrincipal } from "../lib/handoff-identity.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

async function signingSecret(): Promise<string> {
  const configured = process.env.CONDUCTOR_HANDOFF_SIGNING_SECRET?.trim();
  if (configured) return configured;
  try {
    const contents = await readFile(new URL("../.env", import.meta.url), "utf8");
    const line = contents.split(/\r?\n/).find((entry) => entry.trim().startsWith("CONDUCTOR_HANDOFF_SIGNING_SECRET="));
    const value = line?.slice(line.indexOf("=") + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value) return value;
  } catch {
    // The actionable error below intentionally does not reveal any secret path contents.
  }
  throw new Error("CONDUCTOR_HANDOFF_SIGNING_SECRET is not configured in the environment or .env file.");
}

async function main() {
  const actorId = argument("actor");
  const role = argument("role") as HandoffPrincipal["role"] | undefined;
  const kind = argument("kind") as HandoffPrincipal["kind"] | undefined;
  const workspaceId = argument("workspace") ?? "workspace_local";
  const taskId = argument("task");
  const ttlSeconds = Number(argument("ttl") ?? 300);
  if (!actorId || !role || !kind) {
    throw new Error("Usage: npm run handoff:token -- --actor <stable-id> --role <planner|implementer|tester|reviewer> --kind <worker|human> [--workspace workspace_local] [--task task-id] [--ttl 300]");
  }
  if (!["planner", "implementer", "tester", "reviewer"].includes(role)) throw new Error("Invalid --role value.");
  if (!["worker", "human"].includes(kind)) throw new Error("Invalid --kind value.");
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) throw new Error("--ttl must be an integer between 30 and 900 seconds.");
  const token = await createHandoffIdentityToken({
    actorId,
    role,
    kind,
    workspaceId,
    ...(taskId ? { taskId } : {}),
    secret: await signingSecret(),
    ttlSeconds,
  });
  process.stdout.write(`${token}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Unable to create a handoff identity token."}\n`);
  process.exitCode = 1;
});
