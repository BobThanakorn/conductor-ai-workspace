import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("builds the Conductor workspace shell", async () => {
  const [page, portal, layout, workspace, workspaceRoute, repositoriesRoute, agentRoute, provider, environmentStore, builtManifest] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/portal/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/workspace-client.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/workspace/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/repositories/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/agent/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/agent-provider.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/environment-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../dist/server/.vite/manifest.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<PortalPage\s*\/>/);
  assert.match(page, /\.\/portal\/page/);
  assert.match(portal, /Message the Conductor Agent/);
  assert.match(portal, /approvedCompanionAction/);
  assert.match(portal, /\/fs\/tree/);
  assert.match(portal, /\/fs\/read/);
  assert.match(portal, /\/fs\/write/);
  assert.match(portal, /\/terminal\/execute/);
  assert.match(portal, /\/git\/commit/);
  assert.match(portal, /\/provider\/github\/repository/);
  assert.match(portal, /Search repositories/);
  assert.match(portal, /Connect current repository/);
  assert.match(portal, /Clone GitHub repository/);
  assert.match(portal, /\/workspace\/select/);
  assert.match(portal, /\/git\/clone/);
  assert.match(repositoriesRoute, /listRepositories/);
  assert.match(repositoriesRoute, /registerRepository/);
  assert.doesNotMatch(portal, /DTS Assistant|6 active|hello\.txt|next integration phase|พร้อมต่อยอด/);
  assert.match(layout, /Conductor/);
  assert.match(workspace, /data-testid="conductor-workspace"/);
  assert.match(workspace, /Context inspector/);
  assert.match(workspace, /Agent mode/);
  assert.match(workspace, /Source control/);
  assert.match(workspace, /Manage context/);
  assert.match(workspace, /mode: agentMode/);
  assert.match(workspace, /No approval pending/);
  assert.match(workspace, /TASK TERMINAL/);
  assert.match(workspace, /fileTree/);
  assert.match(workspace, /eventStream/);
  assert.match(workspace, /Approve, apply & run/);
  assert.match(workspace, /inspectorPanelRef\.current\?\.scrollTo/);
  assert.match(workspace, /fallbackProposalEntrypoint/);
  assert.match(workspace, /workspaceFiles/);
  assert.match(workspace, /LOCAL_GIT_COMPANION/);
  assert.match(workspace, /git\/commit/);
  assert.match(workspace, /fs\/tree/);
  assert.match(workspace, /fs\/read/);
  assert.match(workspace, /terminal\/execute/);
  assert.match(workspace, /collectRepositoryContext/);
  assert.match(workspace, /includeAmbientRepositoryState/);
  assert.match(workspace, /total \+ bytes > 24_000/);
  assert.match(workspaceRoute, /afterSequence/);
  assert.doesNotMatch(workspace, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
  assert.doesNotMatch(workspace, /Test runner started|Single-use capability issued/i);
  assert.doesNotMatch(workspace, /runPythonSandbox|Fallback proposal|demo mode|Atlas Engineering/i);
  assert.doesNotMatch(agentRoute, /createDemoAgentProposal|liveDiagnostic|provider\s*!==\s*["']demo/i);
  assert.match(agentRoute, /previous provider attempt did not produce a valid structured proposal/i);
  assert.match(agentRoute, /enable_thinking:\s*false/);
  assert.match(agentRoute, /This request is in Ask mode/);
  assert.match(agentRoute, /read_only_answer/);
  assert.doesNotMatch(provider, /provider:\s*["']demo["']/i);
  assert.doesNotMatch(environmentStore, /demoFileTree|demoDiff|Atlas Engineering|Harden session validation/i);
  assert.ok(Object.keys(JSON.parse(builtManifest)).length > 0);
});

test("removes starter artifacts and declares durable state", async () => {
  const [page, layout, packageJson, hosting] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /PortalPage/);
  assert.match(layout, /Conductor/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.deepEqual(JSON.parse(hosting).d1, "DB");

  await assert.rejects(access(new URL("app/_sites-preview", root)));
});
