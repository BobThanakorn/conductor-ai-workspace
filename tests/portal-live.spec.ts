import { expect, test } from "@playwright/test";

test.use({ launchOptions: { channel: "chrome" } });
test.setTimeout(120_000);

test("chat-first portal is wired to the live local runtime", async ({ page }) => {
  await page.goto("http://127.0.0.1:3000/");

  await expect(page.getByText("Repository runtime connected")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Connect current repository" }).click();
  await expect(page.locator(".repository-item").filter({ hasText: "workspace" })).toBeVisible();
  await expect(page.getByLabel("Select model")).toContainText("gpt-5.1-codex-mini · ready");
  await expect(page.getByLabel("Select agent engine")).toContainText("LangChain + LangGraph · ready");
  await page.getByLabel("Select agent engine").selectOption("langgraph");

  await page.getByRole("tab", { name: "⑂ Git" }).click();
  await expect(page.getByRole("heading", { name: "Git workspace" })).toBeVisible();

  await page.getByRole("tab", { name: "▣ Project" }).click();
  await expect(page.getByRole("heading", { name: "Runtime and repository" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Role handoff workflow" })).toBeVisible();
  await expect(page.getByPlaceholder("Paste worker or human handoff token")).toHaveAttribute("type", "password");

  await page.getByRole("tab", { name: "◌ Chat" }).click();
  const composer = page.getByLabel("Message the Conductor Agent");
  await composer.fill("ตอบเพียงคำว่า LIVE_OK และห้ามแก้ไขไฟล์");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByRole("button", { name: "↑" }).click();

  await expect(page.getByText("ตอบเพียงคำว่า LIVE_OK และห้ามแก้ไขไฟล์")).toBeVisible();
  await expect(page.locator(".portal-message.assistant").last()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".portal-error")).toHaveCount(0);
});

test("engine picker excludes configured and unavailable engines", async ({ page }) => {
  await page.route("**/api/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        model: "gpt-5.1-codex-mini",
        models: ["gpt-5.1-codex-mini"],
        modelStatus: { "gpt-5.1-codex-mini": "ready" },
        engines: [
          { id: "openai-agents", name: "OpenAI Agents SDK", status: "ready" },
          { id: "crewai", name: "CrewAI", status: "configured" },
          { id: "haystack", name: "Haystack", status: "unavailable" },
        ],
      }),
    });
  });
  await page.goto("http://127.0.0.1:3000/");
  await expect(page.getByText("Repository runtime connected")).toBeVisible({ timeout: 30_000 });
  const picker = page.getByLabel("Select agent engine");
  await expect(picker.locator("option")).toHaveCount(1);
  await expect(picker).toContainText("OpenAI Agents SDK · ready");
  await expect(picker).not.toContainText("CrewAI");
  await expect(picker).not.toContainText("Haystack");
});

test("Agent mode renders an approval card for a bounded command batch", async ({ page }) => {
  await page.goto("http://127.0.0.1:3000/");
  await expect(page.getByText("Repository runtime connected")).toBeVisible({ timeout: 30_000 });

  const composer = page.getByLabel("Message the Conductor Agent");
  await composer.fill([
    "Create an execution proposal only. Do not create or modify files.",
    "Run this sequential batch using executions: python3 calculator-cli/cli.py add 10 5; python3 calculator-cli/cli.py subtract 10 5; python3 calculator-cli/cli.py multiply 10 5; python3 calculator-cli/cli.py divide 10 2; python3 calculator-cli/cli.py divide 10 0.",
    "Require approval and return execution null.",
  ].join(" "));

  const agentButton = page.getByRole("button", { name: "Agent", exact: true });
  await expect(agentButton).toHaveCount(1);
  await agentButton.click();
  const sendButton = page.getByRole("button", { name: "↑", exact: true });
  await expect(sendButton).toHaveCount(1);
  await sendButton.click();

  await expect(page.getByText("Review proposed command batch")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("button", { name: "Approve & run", exact: true })).toBeVisible();
});

test("Contract v2 apply-and-run uses one approval for the approved operation", async ({ page }) => {
  await page.route("**/api/agent", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        engine: "openai-agents",
        model: "gpt-5.1-codex-mini",
        output: {
          summary: "เสนอรัน calculator หลังอนุมัติ",
          plan: ["รันคำสั่งที่ตรวจสอบแล้ว"],
          proposedAction: "apply_and_run",
          riskLevel: "R1",
          needsApproval: true,
          evidence: [],
          artifacts: [],
          execution: { command: "python3 calculator-cli/cli.py add 2 3", args: [], timeoutMs: 120000 },
          executions: [],
        },
        agentContract: {
          contractVersion: 2,
          mutation: {
            action: "apply_and_run",
            workspaceId: "workspace_local",
            taskId: "task_live_contract",
            snapshot: { repository: "workspace", branch: "main" },
            artifacts: [],
            execution: { command: "python3 calculator-cli/cli.py add 2 3", args: [], timeoutMs: 120000 },
            executions: [],
            operations: [{
              action: "terminal.execute-batch",
              input: { commands: [{ command: "python3 calculator-cli/cli.py add 2 3", cwd: ".", timeoutMs: 120000 }] },
            }],
          },
        },
      }),
    });
  });
  await page.goto("http://127.0.0.1:3000/");
  const composer = page.getByLabel("Message the Conductor Agent");
  await composer.fill("รัน calculator add 2 3 หลังอนุมัติ");
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.getByRole("button", { name: "↑", exact: true }).click();
  await expect(page.getByText("เสนอรัน calculator หลังอนุมัติ")).toBeVisible();
  const approve = page.getByRole("button", { name: "Approve & run", exact: true });
  await expect(approve).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await approve.click();
  await expect(page.getByLabel("Execution result")).toContainText("5.0", { timeout: 30_000 });
  await expect(page.getByLabel("Execution result")).toContainText("exit 0");
});

test("prose-only Agent output is recovered and executes the exact reviewed commands", async ({ page }) => {
  const reviewedCommands = [
    "python3 calculator-cli/cli.py add 10 5",
    "python3 calculator-cli/cli.py subtract 10 5",
    "python3 calculator-cli/cli.py multiply 10 5",
    "python3 calculator-cli/cli.py divide 10 2",
    "python3 calculator-cli/cli.py divide 10 0",
  ];
  await page.route("**/api/agent", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        output: {
          summary: "Plan to run the requested calculator commands after approval.",
          plan: ["Run all five explicit commands and report every exit code."],
          proposedAction: "Run calculator checks.",
          riskLevel: "R1",
          needsApproval: true,
          evidence: [],
          artifacts: [],
          execution: null,
        },
        agentContract: {
          contractVersion: 2,
          runId: "run_live_prose_recovery",
          framework: "openai-agents",
          model: "gpt-5.1-codex-mini",
          request: {
            mode: "agent",
            workspaceId: "workspace_local",
            taskId: "task_d93354a2dbaa",
            snapshot: { repository: "workspace", branch: "main", headSha: "b1b9cfdc9b17" },
          },
          proposal: {
            summary: "Plan to run the requested calculator commands after approval.",
            plan: ["Run all five explicit commands and report every exit code."],
            proposedAction: "run_calculator_checks",
            riskLevel: "R1",
            needsApproval: true,
            evidence: [],
            artifacts: [],
            execution: null,
            executions: reviewedCommands.map((command) => ({ command, args: [], timeoutMs: 120000 })),
          },
          mutation: {
            action: "run_calculator_checks",
            workspaceId: "workspace_local",
            taskId: "task_d93354a2dbaa",
            snapshot: { repository: "workspace", branch: "main", headSha: "b1b9cfdc9b17" },
            artifacts: [],
            execution: null,
            executions: reviewedCommands.map((command) => ({ command, args: [], timeoutMs: 120000 })),
            operations: [{
              action: "terminal.execute-batch",
              input: { commands: reviewedCommands.map((command) => ({ command, cwd: ".", timeoutMs: 120000 })) },
            }],
          },
          approval: { required: true, payload: null },
        },
      }),
    });
  });
  await page.goto("http://127.0.0.1:3000/");

  const composer = page.getByLabel("Message the Conductor Agent");
  await composer.fill([
    "Run these commands as an approved batch:",
    "python3 calculator-cli/cli.py add 10 5",
    "python3 calculator-cli/cli.py subtract 10 5",
    "python3 calculator-cli/cli.py multiply 10 5",
    "python3 calculator-cli/cli.py divide 10 2",
    "python3 calculator-cli/cli.py divide 10 0",
  ].join("\n"));
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.getByRole("button", { name: "↑", exact: true }).click();

  await expect(page.getByText("Review proposed command batch")).toBeVisible();
  const approve = page.getByRole("button", { name: "Approve & run", exact: true });
  await expect(approve).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await approve.click();

  const executionResult = page.getByLabel("Execution result");
  await expect(executionResult).toBeVisible({ timeout: 30_000 });
  await expect(executionResult).toContainText("15.0");
  await expect(executionResult).toContainText("Error: Cannot divide by zero");
  await expect(executionResult).toContainText("exit 1");

  const chatScroll = page.locator(".chat-scroll");
  await chatScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(composer).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("benchmark displays answer, tokens, latency, tools, and audit log for both engines", async ({ page }) => {
  const benchmarkContexts: Array<Array<{ path: string; content: string }>> = [];
  await page.route("**/api/agent", async (route) => {
    const request = route.request().postDataJSON() as {
      engine: string;
      message: string;
      workspaceFiles?: Array<{ path: string; content: string }>;
    };
    benchmarkContexts.push(request.workspaceFiles ?? []);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        engine: request.engine,
        model: "gpt-5.1-codex-mini",
        output: {
          summary: `${request.engine} benchmark answer`,
          plan: [],
          proposedAction: "read_only_answer",
          riskLevel: "R0",
          needsApproval: false,
          evidence: [],
          artifacts: [],
          execution: null,
        },
        telemetry: {
          durationMs: request.engine === "langgraph" ? 180 : 120,
          providerDurationMs: request.engine === "langgraph" ? 160 : 100,
          tokenUsage: { requests: 1, inputTokens: 40, outputTokens: 10, totalTokens: 50 },
          tools: [{ name: "read_repository", status: "completed" }],
          auditLog: [{
            at: "2026-07-31T00:00:00.000Z",
            stage: "agent.model.completed",
            detail: "Model completed with 50 reported token(s).",
          }],
        },
      }),
    });
  });
  await page.goto("http://127.0.0.1:3000/");
  await page.getByRole("tab", { name: "◫ Benchmark" }).click();
  await page.getByRole("button", { name: "Run comparison" }).click();

  // Only runtime-ready engines are selectable; this local deployment exposes
  // OpenAI Agents and LangGraph, while configured/unavailable engines stay out
  // of the picker by design.
  await expect(page.locator(".benchmark-card")).toHaveCount(2);
  await expect(page.getByText(/Repository snapshot used by both engines/)).toBeVisible();
  await expect(page.getByText("openai-agents benchmark answer")).toBeVisible();
  await expect(page.getByText("langgraph benchmark answer")).toBeVisible();
  for (const card of await page.locator(".benchmark-card").all()) {
    await expect(card.locator("dt").filter({ hasText: "Reported tokens" })).toBeVisible();
    await expect(card.locator("dd").filter({ hasText: "50" }).first()).toBeVisible();
  }
  await page.locator(".benchmark-card").first().getByText(/Tools used/).click();
  await expect(page.locator(".benchmark-card").first()).toContainText("read_repository");
  await page.locator(".benchmark-card").first().getByText(/Audit log/).click();
  await expect(page.locator(".benchmark-card").first()).toContainText("agent.model.completed");
  expect(benchmarkContexts).toHaveLength(await page.locator(".benchmark-card").count());
  expect(benchmarkContexts[0].length).toBeGreaterThan(0);
  expect(benchmarkContexts[1].map((file) => file.path)).toEqual(
    benchmarkContexts[0].map((file) => file.path),
  );
});

test("MCP control center enforces visible default-deny policy and sends scoped admin actions", async ({ page }) => {
  const registryPosts: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const policyPosts: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
  let serverStatus: "connected" | "disconnected" = "connected";
  let revision = 7;
  let workspaceReadDecision: "inherit" | "allow" = "inherit";

  const registryPayload = () => ({
    ok: true,
    workspaceId: "workspace_local",
    registrationOptions: [{ id: "docker-mcp-gateway", label: "Docker MCP Gateway", transport: "streamable-http" }],
    servers: [{
      workspaceId: "workspace_local",
      serverId: "docker-mcp-gateway",
      allowlistId: "docker-mcp-gateway",
      label: "Docker MCP Gateway",
      status: serverStatus,
      enabled: serverStatus === "connected",
      tools: [
        {
          name: "read_repository",
          title: "Read repository",
          description: "Read repository metadata.",
          inputSchema: {},
          risk: "read",
          requiresApproval: false,
          serverId: "docker-mcp-gateway",
          provenance: { source: "mcp", serverId: "docker-mcp-gateway", transport: "streamable-http" },
        },
        {
          name: "create_issue",
          title: "Create issue",
          description: "Create an issue in an external repository.",
          inputSchema: {},
          risk: "external",
          requiresApproval: true,
          serverId: "docker-mcp-gateway",
          provenance: { source: "mcp", serverId: "docker-mcp-gateway", transport: "streamable-http" },
        },
      ],
      lastCheckedAt: "2026-08-07T04:00:00.000Z",
      createdAt: "2026-08-07T03:00:00.000Z",
      updatedAt: "2026-08-07T04:00:00.000Z",
    }],
    events: [{
      sequence: 1,
      id: "mcpe_connected",
      workspaceId: "workspace_local",
      serverId: "docker-mcp-gateway",
      type: "mcp.server.connected",
      status: serverStatus,
      createdAt: "2026-08-07T04:00:00.000Z",
    }],
  });

  const policyPayload = (agentId?: string) => ({
    ok: true,
    workspaceId: "workspace_local",
    revision,
    ...(agentId ? { agentId } : {}),
    policies: workspaceReadDecision === "allow" ? [{
      workspaceId: "workspace_local",
      scopeType: "workspace",
      scopeId: "workspace_local",
      serverId: "docker-mcp-gateway",
      toolName: "read_repository",
      decision: "allow",
      risk: "read",
      requiresApproval: false,
      revision,
      updatedBy: "operator",
      createdAt: "2026-08-07T04:02:00.000Z",
      updatedAt: "2026-08-07T04:02:00.000Z",
    }] : [],
    effective: [
      {
        serverId: "docker-mcp-gateway",
        toolName: "read_repository",
        title: "Read repository",
        description: "Read repository metadata.",
        risk: "read",
        requiresApproval: false,
        workspaceDecision: workspaceReadDecision,
        agentDecision: "inherit",
        effectiveDecision: workspaceReadDecision === "allow" ? "allow" : "deny",
        reason: workspaceReadDecision === "allow" ? "workspace_allow" : "default_deny",
      },
      {
        serverId: "docker-mcp-gateway",
        toolName: "create_issue",
        title: "Create issue",
        description: "Create an issue in an external repository.",
        risk: "external",
        requiresApproval: true,
        workspaceDecision: "inherit",
        agentDecision: "inherit",
        effectiveDecision: "deny",
        reason: "default_deny",
      },
    ],
    events: workspaceReadDecision === "allow" ? [{
      sequence: 1,
      id: "mcp_policy_allow_read",
      workspaceId: "workspace_local",
      scopeType: "workspace",
      scopeId: "workspace_local",
      serverId: "docker-mcp-gateway",
      toolName: "read_repository",
      risk: "read",
      previousDecision: "inherit",
      decision: "allow",
      previousRevision: 7,
      revision: 8,
      actorId: "operator",
      createdAt: "2026-08-07T04:02:00.000Z",
    }] : [],
  });

  await page.route(/\/api\/mcp(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      registryPosts.push({
        headers: route.request().headers(),
        body: route.request().postDataJSON() as Record<string, unknown>,
      });
      serverStatus = "disconnected";
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(registryPayload()) });
  });

  await page.route("**/api/mcp/policies**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      policyPosts.push({
        headers: request.headers(),
        body: request.postDataJSON() as Record<string, unknown>,
      });
      if (policyPosts.length > 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "Policy revision changed. Refresh and review the effective decision." } }),
        });
        return;
      }
      workspaceReadDecision = "allow";
      revision = 8;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          replayed: false,
          workspaceId: "workspace_local",
          revision,
          policy: policyPayload().policies[0],
          effective: policyPayload().effective,
        }),
      });
      return;
    }
    const agentId = new URL(request.url()).searchParams.get("agentId") ?? undefined;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(policyPayload(agentId)) });
  });

  await page.goto("http://127.0.0.1:3000/");
  const initialChatTab = page.getByRole("tab", { name: /Chat/ });
  await initialChatTab.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  const mcpTab = page.getByRole("tab", { name: /MCP/ });
  await expect(mcpTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Servers, tools, and permissions" })).toBeVisible();
  await expect(page.getByText("Default deny is enforced by the server")).toBeVisible();

  const token = page.getByLabel("MCP administrator token");
  await expect(token).toHaveAttribute("type", "password");
  await token.fill("e2e-admin-token");

  const externalTool = page.locator("article").filter({ hasText: "create_issue" });
  await expect(externalTool.getByText("External", { exact: true })).toBeVisible();
  await expect(externalTool.getByText("Approval required", { exact: true })).toBeVisible();
  await expect(externalTool.getByText("Denied", { exact: true })).toBeVisible();
  const readTool = page.locator("article").filter({ hasText: "read_repository" });
  await expect(readTool.getByText("Read", { exact: true })).toBeVisible();
  await expect(readTool.getByText("Denied", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect.poll(() => registryPosts.length).toBe(1);
  expect(registryPosts[0].headers["x-conductor-mcp-admin"]).toBe("e2e-admin-token");
  expect(registryPosts[0].body).toEqual({
    workspaceId: "workspace_local",
    action: "disconnect",
    serverId: "docker-mcp-gateway",
  });
  await expect(page.getByText("disconnected", { exact: true })).toBeVisible();

  await readTool.getByRole("button", { name: "Allow", exact: true }).click();
  await expect.poll(() => policyPosts.length).toBe(1);
  expect(policyPosts[0].headers["x-conductor-mcp-admin"]).toBe("e2e-admin-token");
  expect(policyPosts[0].headers["idempotency-key"]).toBeTruthy();
  expect(policyPosts[0].body).toEqual({
    workspaceId: "workspace_local",
    expectedRevision: 7,
    scope: { type: "workspace" },
    serverId: "docker-mcp-gateway",
    toolName: "read_repository",
    decision: "allow",
  });
  await expect(readTool.getByText("Allowed", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Append-only audit" })).toBeVisible();
  await expect(page.getByText("allow · read_repository")).toBeVisible();

  const agentScope = page.getByRole("radio", { name: "Agent", exact: true });
  await agentScope.focus();
  await page.keyboard.press("Space");
  await page.getByLabel("Agent ID").fill("coding-agent");
  await page.getByRole("button", { name: "Load agent policy" }).click();
  await expect.poll(async () => page.getByText("Agent policy can inherit or further restrict it.").isVisible()).toBe(true);
  await page.locator("article").filter({ hasText: "read_repository" }).getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Policy revision changed");
  expect(policyPosts[1].body).toMatchObject({
    expectedRevision: 8,
    scope: { type: "agent", agentId: "coding-agent" },
    decision: "allow",
  });

  const chatTab = page.getByRole("tab", { name: /Chat/ });
  await chatTab.focus();
  await page.keyboard.press("Enter");
  const composer = page.getByLabel("Message the Conductor Agent");
  await expect(composer).toBeVisible();
  const composerBox = await composer.locator("xpath=..").boundingBox();
  expect(composerBox).not.toBeNull();
  expect((composerBox?.y ?? 0) + (composerBox?.height ?? 0)).toBeLessThanOrEqual(720);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await mcpTab.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("MCP administrator token")).toHaveValue("");
});

test("Automations UI edits immutable profiles, bounded triggers, and approval-gated runs", async ({ page }) => {
  const profiles: Array<Record<string, unknown>> = [];
  const automations: Array<Record<string, unknown>> = [];
  const runs: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const snapshots: Array<Record<string, unknown>> = [];
  const posts: Array<Record<string, unknown>> = [];

  await page.route("**/api/automations**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      posts.push(body);
      if (body.action === "profile") {
        const version = profiles.filter((item) => item.id === body.profileId && item.kind === body.kind).length + 1;
        profiles.unshift({ id: body.profileId, kind: body.kind, version, name: body.name, definition_json: JSON.stringify(body.definition), created_at: new Date().toISOString() });
      } else if (body.action === "automation") {
        automations.unshift({ id: body.automationId, name: body.name, enabled: 1, trigger_json: JSON.stringify(body.trigger), agent_profile_id: body.agentProfileId, agent_profile_version: body.agentProfileVersion, skill_profile_id: body.skillProfileId, skill_profile_version: body.skillProfileVersion, next_run_at: null });
      } else if (body.action === "run") {
        const runId = "run-e2e";
        runs.unshift({ id: runId, automation_id: body.automationId, status: "queued", task_id: "task-e2e", snapshot_id: "snapshot-e2e", created_at: new Date().toISOString(), cancel_requested: 0 });
        events.unshift({ event_id: "event-e2e", run_id: runId, type: "automation.run.materialized", detail_json: JSON.stringify({ approvalRequired: true }), created_at: new Date().toISOString() });
        snapshots.unshift({ id: "snapshot-e2e", run_id: runId, manifest_json: JSON.stringify({ workspace: { headSha: "a".repeat(40) } }), created_at: new Date().toISOString() });
      } else if (body.action === "cancel") {
        if (runs[0]) runs[0].status = "cancelled";
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, workspaceId: "workspace_local", profiles, automations, runs, events, snapshots }) });
  });

  await page.goto("http://127.0.0.1:3000/");
  await page.getByRole("tab", { name: /Automations/ }).click();
  await expect(page.getByRole("heading", { name: "Automations", exact: true })).toBeVisible();
  await page.getByPlaceholder("Paste a short-lived signed human token").fill("signed-e2e-human-token");

  await page.getByLabel("Stable profile ID").fill("thai-agent");
  await page.getByLabel("Display name").fill("Thai Agent");
  await page.getByLabel("System prompt").fill("ตอบเป็นภาษาไทยและรอการอนุมัติก่อน mutation");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("agent · thai-agent@1")).toBeVisible();

  await page.getByLabel("Profile type").selectOption("skill");
  await page.getByLabel("Stable profile ID").fill("safe-skills");
  await page.getByLabel("Display name").fill("Safe Skills");
  await page.getByLabel("Allowlisted skills").fill("repository-search, test-runner");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("skill · safe-skills@1")).toBeVisible();

  await page.getByLabel("Automation name").fill("Nightly review");
  await page.getByLabel("Agent profile").selectOption("thai-agent@1");
  await page.getByLabel("Skill profile").selectOption("safe-skills@1");
  await page.locator("label").filter({ hasText: /^Trigger/ }).locator("select").selectOption("command");
  await page.getByLabel("Named command").fill("daily-review");
  await page.getByRole("button", { name: "Save automation" }).click();
  await expect(page.getByText("Nightly review")).toBeVisible();
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText("queued", { exact: true })).toBeVisible();
  await page.locator("details").filter({ hasText: "queued" }).locator("summary").click();
  await expect(page.getByText("automation.run.materialized")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("cancelled", { exact: true })).toBeVisible();

  expect(posts).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: "profile", kind: "agent", profileId: "thai-agent" }),
    expect.objectContaining({ action: "profile", kind: "skill", profileId: "safe-skills" }),
    expect.objectContaining({ action: "automation", trigger: { type: "command", command: "daily-review" }, agentProfileId: "thai-agent", agentProfileVersion: 1, skillProfileId: "safe-skills", skillProfileVersion: 1 }),
    expect.objectContaining({ action: "run", command: "daily-review" }),
    expect.objectContaining({ action: "cancel", runId: "run-e2e" }),
  ]));
});
