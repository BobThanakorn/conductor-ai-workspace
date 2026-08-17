import assert from "node:assert/strict";
import test from "node:test";

import { formatUntrustedSkillBundle } from "../lib/skill-context.ts";
import {
  parseEnabledSkillsFromTaskGoal,
  parseSkillMarkdown,
  resolveActiveSkills,
} from "../lib/skill-registry.ts";

const sampleSkill = `---
name: repo-review
description: Review pull requests with team standards. Use when reviewing PRs or diffs.
disable-model-invocation: false
---

# Repo review

Follow the team checklist.
`;

test("parses Cursor-style SKILL.md frontmatter", () => {
  const skill = parseSkillMarkdown(sampleSkill, ".cursor/skills/repo-review/SKILL.md");
  assert.equal(skill?.id, "repo-review");
  assert.match(skill?.description ?? "", /Review pull requests/);
  assert.equal(skill?.disableModelInvocation, false);
});

test("resolveActiveSkills honors explicit ids and auto-match descriptions", () => {
  const catalog = [
    parseSkillMarkdown(sampleSkill, ".cursor/skills/repo-review/SKILL.md")!,
    parseSkillMarkdown(`---
name: pdf-helper
description: Extract tables from PDF files for analysis.
disable-model-invocation: false
---
`, ".cursor/skills/pdf-helper/SKILL.md")!,
  ];
  const explicit = resolveActiveSkills({
    catalog,
    message: "please review this diff",
    explicitIds: ["repo-review"],
    allowAutoInvoke: false,
  });
  assert.deepEqual(explicit.map((skill) => skill.id), ["repo-review"]);

  const auto = resolveActiveSkills({
    catalog,
    message: "extract tables from this pdf file",
  });
  assert.deepEqual(auto.map((skill) => skill.id), ["pdf-helper"]);
});

test("parses automation enabled skills from task goal text", () => {
  assert.deepEqual(
    parseEnabledSkillsFromTaskGoal("Enabled skills: repository-search, test-runner. Human approval required."),
    ["repository-search", "test-runner"],
  );
});

test("formats skill guides as untrusted prompt context", () => {
  const bundle = formatUntrustedSkillBundle([
    parseSkillMarkdown(sampleSkill, ".cursor/skills/repo-review/SKILL.md")!,
  ]);
  assert.match(bundle, /<untrusted_skill_guides>/);
  assert.match(bundle, /repo-review/);
  assert.match(bundle, /do not authorize writes/i);
});
