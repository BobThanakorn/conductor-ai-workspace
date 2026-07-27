import { expect, test } from "@playwright/test";

test.use({ launchOptions: { channel: "chrome" } });

test("chat-first portal is wired to the live local runtime", async ({ page }) => {
  await page.goto("http://127.0.0.1:3000/");

  await expect(page.getByText("Execution companion connected")).toBeVisible();
  await expect(page.getByLabel("Select model")).toContainText("gpt-5.1-codex-mini · ready");

  await page.getByRole("button", { name: "⑂ Git" }).click();
  await expect(page.getByRole("heading", { name: "Git workspace" })).toBeVisible();

  await page.getByRole("button", { name: "▣ Project" }).click();
  await expect(page.getByRole("heading", { name: "Runtime and repository" })).toBeVisible();

  await page.getByRole("button", { name: "◌ Chat" }).click();
  const composer = page.getByLabel("Message the Conductor Agent");
  await composer.fill("ตอบเพียงคำว่า LIVE_OK และห้ามแก้ไขไฟล์");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByRole("button", { name: "↑" }).click();

  await expect(page.getByText("ตอบเพียงคำว่า LIVE_OK และห้ามแก้ไขไฟล์")).toBeVisible();
  await expect(page.locator(".portal-message.assistant").last()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".portal-error")).toHaveCount(0);
});

test("Agent mode renders an approval card for a bounded command batch", async ({ page }) => {
  await page.goto("http://127.0.0.1:3000/");
  await expect(page.getByText("Execution companion connected")).toBeVisible();

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
  await expect(page.getByRole("button", { name: "Approve, apply & run", exact: true })).toBeVisible();
});
