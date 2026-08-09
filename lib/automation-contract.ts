import { z } from "zod";
import { ApiError } from "./api-contract.ts";

const commandName = z.string().trim().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const cron = z.string().trim().regex(/^\*\/(?:[1-9]|[1-5][0-9]) \* \* \* \*$/);

export const agentProfileDefinitionSchema = z.object({
  systemPrompt: z.string().trim().min(1).max(8_000),
  model: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/).optional(),
  maxSteps: z.number().int().min(1).max(32).default(8),
}).strict();

export const skillProfileDefinitionSchema = z.object({
  skills: z.array(commandName).max(32),
}).strict();

export const automationProfileDefinitionSchema = z.union([
  agentProfileDefinitionSchema,
  skillProfileDefinitionSchema,
]);

export const automationTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual") }).strict(),
  z.object({ type: z.literal("schedule"), every: cron }).strict(),
  z.object({ type: z.literal("webhook"), hookId: commandName }).strict(),
  z.object({ type: z.literal("command"), command: commandName }).strict(),
]);

export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
export type AgentProfileDefinition = z.infer<typeof agentProfileDefinitionSchema>;
export type SkillProfileDefinition = z.infer<typeof skillProfileDefinitionSchema>;

export function parseAutomationTrigger(value: unknown): AutomationTrigger {
  const parsed = automationTriggerSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "automation_trigger_invalid", "Automation triggers are limited to manual, bounded schedule, authenticated webhook, or allowlisted named command.");
  return parsed.data;
}

export function parseAutomationProfileDefinition(
  kind: "agent" | "skill",
  value: unknown,
): AgentProfileDefinition | SkillProfileDefinition {
  const parsed = kind === "agent"
    ? agentProfileDefinitionSchema.safeParse(value)
    : skillProfileDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, "automation_profile_invalid", `The ${kind} profile definition is invalid.`);
  }
  return parsed.data;
}

export function scheduleEveryMinutes(trigger: AutomationTrigger): number | null {
  if (trigger.type !== "schedule") return null;
  return Number(trigger.every.slice(2).split(" ")[0]);
}

export function nextScheduledRun(trigger: AutomationTrigger, now = new Date()): string | null {
  if (trigger.type !== "schedule") return null;
  const minutes = scheduleEveryMinutes(trigger)!;
  return new Date(Math.floor(now.getTime() / 60_000 / minutes + 1) * minutes * 60_000).toISOString();
}

/**
 * Bind webhook routing metadata and the exact request body into one signed
 * byte sequence. Without this prefix, a valid body signature could be replayed
 * against a different workspace or hook that shares the server-side secret.
 */
export function automationWebhookSignaturePayload(
  workspaceId: string,
  hookId: string,
  rawBody: Uint8Array,
): Uint8Array {
  const prefix = new TextEncoder().encode(`${workspaceId}\n${hookId}\n`);
  const payload = new Uint8Array(prefix.length + rawBody.length);
  payload.set(prefix);
  payload.set(rawBody, prefix.length);
  return payload;
}
