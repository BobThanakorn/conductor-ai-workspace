import { ApiError } from "./api-contract.ts";
import { formatUntrustedSkillBundle } from "./skill-context.ts";
import {
  resolveActiveSkills,
  type SkillCatalogEntry,
  type SkillRecord,
} from "./skill-registry.ts";

const COMPANION_INTERNAL_URL = process.env.CONDUCTOR_COMPANION_INTERNAL_URL ?? "http://companion:8765";

type SkillResolveResponse = {
  ok?: boolean;
  skills?: SkillRecord[];
  catalog?: SkillCatalogEntry[];
  error?: string;
};

export async function fetchSkillCatalog(companionUrl = COMPANION_INTERNAL_URL): Promise<SkillCatalogEntry[]> {
  const response = await fetch(`${companionUrl.replace(/\/$/, "")}/skills/catalog`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return [];
  const payload = await response.json() as SkillResolveResponse;
  return payload.catalog ?? [];
}

export async function loadSkillsForAgentRequest(args: {
  message: string;
  explicitSkillIds?: string[];
  taskGoal?: string | null;
  companionUrl?: string;
}): Promise<{ bundle: string; active: SkillRecord[]; catalog: SkillCatalogEntry[] }> {
  const companionUrl = args.companionUrl ?? COMPANION_INTERNAL_URL;
  let payload: SkillResolveResponse;
  try {
    const response = await fetch(`${companionUrl.replace(/\/$/, "")}/skills/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        message: args.message,
        skillIds: args.explicitSkillIds ?? [],
        taskGoal: args.taskGoal ?? null,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`Companion skill resolver returned ${response.status}.`);
    }
    payload = await response.json() as SkillResolveResponse;
  } catch {
    return { bundle: formatUntrustedSkillBundle([]), active: [], catalog: [] };
  }

  const catalogRecords = (payload.skills?.length ? payload.skills : payload.catalog ?? []) as SkillRecord[];
  const catalog: SkillCatalogEntry[] = catalogRecords.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    disableModelInvocation: skill.disableModelInvocation,
  }));

  if (payload.skills?.length) {
    return {
      bundle: formatUntrustedSkillBundle(payload.skills),
      active: payload.skills,
      catalog,
    };
  }

  try {
    const active = resolveActiveSkills({
      catalog: catalogRecords as SkillRecord[],
      message: args.message,
      explicitIds: args.explicitSkillIds,
      taskGoal: args.taskGoal,
    });
    return {
      bundle: formatUntrustedSkillBundle(active),
      active,
      catalog,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Skill resolution failed.";
    throw new ApiError(400, "skill_not_found", message, {
      catalog: catalog.map((skill) => skill.id),
    });
  }
}
