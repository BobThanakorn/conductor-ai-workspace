import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  parseSkillMarkdown,
  toSkillCatalogEntry,
  type SkillCatalogEntry,
  type SkillRecord,
} from "../lib/skill-registry.ts";
import { readWorkspaceFile } from "./execution-plane.ts";

const SKILL_ROOTS = [".cursor/skills", "skills"] as const;

async function listSkillDirectories(root: string, relativeRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(root, relativeRoot), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.posix.join(relativeRoot.replace(/\\/g, "/"), entry.name));
  } catch {
    return [];
  }
}

export async function discoverWorkspaceSkills(root: string): Promise<SkillRecord[]> {
  const catalog = new Map<string, SkillRecord>();
  for (const skillRoot of SKILL_ROOTS) {
    for (const directory of await listSkillDirectories(root, skillRoot)) {
      const skillPath = path.posix.join(directory, "SKILL.md");
      try {
        const file = await readWorkspaceFile(root, skillPath);
        const parsed = parseSkillMarkdown(file.content, file.path, path.posix.basename(directory));
        if (!parsed || catalog.has(parsed.id)) continue;
        catalog.set(parsed.id, parsed);
      } catch {
        // Missing, unreadable, or invalid skill files are omitted from the catalog.
      }
    }
  }
  return [...catalog.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function discoverWorkspaceSkillCatalog(root: string): Promise<SkillCatalogEntry[]> {
  return (await discoverWorkspaceSkills(root)).map(toSkillCatalogEntry);
}

export async function loadWorkspaceSkillsById(root: string, ids: string[]): Promise<SkillRecord[]> {
  const catalog = await discoverWorkspaceSkills(root);
  const byId = new Map(catalog.map((skill) => [skill.id, skill]));
  return ids.map((id) => {
    const skill = byId.get(id.trim().toLowerCase());
    if (!skill) throw new Error(`Unknown skill id: ${id}`);
    return skill;
  });
}
