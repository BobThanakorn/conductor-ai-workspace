export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  body: string;
  path: string;
  disableModelInvocation: boolean;
};

export type SkillCatalogEntry = Omit<SkillRecord, "body">;

export const MAX_SKILL_BODY_CHARS = 16_000;
export const MAX_SKILLS_PER_REQUEST = 4;
export const MAX_TOTAL_SKILL_CHARS = 24_000;
export const SKILL_ID_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

const SKILL_ROOTS = [".cursor/skills", "skills"] as const;

export function skillDiscoveryRoots(): readonly string[] {
  return SKILL_ROOTS;
}

function parseFrontmatter(content: string): { metadata: Record<string, string>; body: string } {
  if (!content.startsWith("---\n")) {
    return { metadata: {}, body: content.trim() };
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return { metadata: {}, body: content.trim() };
  }
  const metadata: Record<string, string> = {};
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key) metadata[key] = value;
  }
  return { metadata, body: content.slice(end + 4).trim() };
}

function normalizeSkillId(value: string | undefined, fallback: string): string {
  const candidate = (value ?? fallback).trim().toLowerCase();
  if (!SKILL_ID_PATTERN.test(candidate)) {
    throw new Error(`Invalid skill id: ${candidate}`);
  }
  return candidate;
}

export function parseSkillMarkdown(
  content: string,
  skillPath: string,
  fallbackId?: string,
): SkillRecord | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const { metadata, body } = parseFrontmatter(trimmed);
  const directoryId = fallbackId
    ?? skillPath.split("/").filter(Boolean).slice(-2, -1)[0]
    ?? skillPath;
  let id: string;
  try {
    id = normalizeSkillId(metadata.name, directoryId);
  } catch {
    return null;
  }
  const disableModelInvocation = metadata["disable-model-invocation"]?.toLowerCase() !== "false";
  const description = (metadata.description ?? body.split(/\r?\n/).find(Boolean) ?? id).trim().slice(0, 1_024);
  return {
    id,
    name: (metadata.name ?? id).trim().slice(0, 64),
    description,
    body: body.slice(0, MAX_SKILL_BODY_CHARS),
    path: skillPath.replace(/\\/g, "/"),
    disableModelInvocation,
  };
}

export function toSkillCatalogEntry(skill: SkillRecord): SkillCatalogEntry {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    disableModelInvocation: skill.disableModelInvocation,
  };
}

export function parseEnabledSkillsFromTaskGoal(goal: string | undefined | null): string[] {
  if (!goal) return [];
  const match = goal.match(/Enabled skills:\s*([^\n.]+)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => SKILL_ID_PATTERN.test(value));
}

function scoreSkillMatch(skill: SkillRecord, message: string): number {
  const haystack = message.toLowerCase();
  let score = 0;
  if (haystack.includes(skill.id)) score += 12;
  if (haystack.includes(skill.name.toLowerCase())) score += 8;
  for (const token of skill.description.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < 5) continue;
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

export function resolveActiveSkills(args: {
  catalog: SkillRecord[];
  message: string;
  explicitIds?: string[];
  taskGoal?: string | null;
  allowAutoInvoke?: boolean;
  maxSkills?: number;
}): SkillRecord[] {
  const maxSkills = Math.min(Math.max(args.maxSkills ?? MAX_SKILLS_PER_REQUEST, 1), MAX_SKILLS_PER_REQUEST);
  const byId = new Map(args.catalog.map((skill) => [skill.id, skill]));
  const requested = new Set<string>([
    ...(args.explicitIds ?? []).map((id) => id.trim().toLowerCase()).filter(Boolean),
    ...parseEnabledSkillsFromTaskGoal(args.taskGoal),
  ]);

  const selected: SkillRecord[] = [];
  const missing: string[] = [];
  for (const id of requested) {
    const skill = byId.get(id);
    if (!skill) {
      missing.push(id);
      continue;
    }
    if (!selected.some((entry) => entry.id === skill.id)) selected.push(skill);
  }
  if (missing.length) {
    throw new Error(`Unknown skill id(s): ${missing.join(", ")}`);
  }

  if (args.allowAutoInvoke !== false) {
    const autoCandidates = args.catalog
      .filter((skill) => !skill.disableModelInvocation && !selected.some((entry) => entry.id === skill.id))
      .map((skill) => ({ skill, score: scoreSkillMatch(skill, args.message) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    for (const entry of autoCandidates) {
      if (selected.length >= maxSkills) break;
      selected.push(entry.skill);
    }
  }

  let totalChars = 0;
  const bounded: SkillRecord[] = [];
  for (const skill of selected.slice(0, maxSkills)) {
    if (totalChars + skill.body.length > MAX_TOTAL_SKILL_CHARS) break;
    bounded.push(skill);
    totalChars += skill.body.length;
  }
  return bounded;
}
