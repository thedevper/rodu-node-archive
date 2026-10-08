import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

// End-to-end probe of `shoal web`: a throwaway workspace, the real CLI and server, and the built UI.
// Requires `pnpm build:web` first.

const CLI = resolve(import.meta.dirname, "../../cli/src/main.ts");
let dir: string;
let server: ChildProcess;
let link: string;

function shoal(...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, SHOAL_DIR: join(dir, ".shoal") },
    encoding: "utf8",
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "shoal-e2e-"));
  shoal("init", "--name", "alice", "--key", "MED", "--title", "Medical app");
  shoal("add", "Fix login crash", "--type", "bug", "--priority", "urgent", "--assignee", "me");
  shoal("add", "Write onboarding doc");
  shoal("add", "Export PDF report", "--priority", "high");
  server = spawn(process.execPath, [CLI, "web", "--port", "0"], {
    env: { ...process.env, SHOAL_DIR: join(dir, ".shoal") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  link = await new Promise<string>((done, fail) => {
    let output = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /Open: (\S+)/.exec(output);
      if (match?.[1]) done(match[1]);
    });
    server.once("exit", (code) => fail(new Error(`shoal web exited with ${code}`)));
  });
});

test.afterAll(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const column = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const card = (page: Page, key: string) => page.locator(`[data-card="${key}"]`);
const keysIn = (page: Page, name: string) =>
  column(page, name)
    .locator("[data-card]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-card")));

test("loads the board and drops the token from the address bar", async ({ page }) => {
  await page.goto(link);
  for (const name of ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"]) {
    await expect(column(page, name)).toBeVisible();
  }
  await expect.poll(() => keysIn(page, "Backlog")).toEqual(["MED-1", "MED-2", "MED-3"]);
  expect(page.url()).not.toContain("token");
});

test("shows the workflow refusal when moving an unassigned card into progress", async ({
  page,
}) => {
  await page.goto(link);
  await card(page, "MED-2").dragTo(column(page, "In Progress"));
  const alert = page.getByRole("alert");
  await expect(alert).toContainText('cannot move to "In Progress" yet');
  await expect(alert).toContainText("assign it first");
  await expect.poll(() => keysIn(page, "Backlog")).toContain("MED-2");
  await expect.poll(() => keysIn(page, "In Progress")).toEqual([]);
});

test("moves an assigned card to another column", async ({ page }) => {
  await page.goto(link);
  await card(page, "MED-1").dragTo(column(page, "In Progress"));
  await expect.poll(() => keysIn(page, "In Progress")).toEqual(["MED-1"]);
  expect(shoal("ls", "status = 'In Progress'").trim()).toBe(
    "MED-1 [In Progress] (urgent) Fix login crash",
  );
});

test("reorders cards within a column and keeps the order after reload", async ({ page }) => {
  await page.goto(link);
  await expect.poll(() => keysIn(page, "Backlog")).toEqual(["MED-2", "MED-3"]);
  await card(page, "MED-3").dragTo(card(page, "MED-2"), { targetPosition: { x: 20, y: 2 } });
  await expect.poll(() => keysIn(page, "Backlog")).toEqual(["MED-3", "MED-2"]);
  await page.reload();
  await expect.poll(() => keysIn(page, "Backlog")).toEqual(["MED-3", "MED-2"]);
});

test("filters with JQL-lite and reports bad queries", async ({ page }) => {
  await page.goto(link);
  const filter = page.getByLabel("Filter");
  await filter.fill("priority = high");
  await filter.press("Enter");
  await expect.poll(() => keysIn(page, "Backlog")).toEqual(["MED-3"]);
  await filter.fill("nope = 1");
  await filter.press("Enter");
  await expect(page.getByRole("alert")).toContainText('unknown field "nope"');
});

test("edits an item and comments in the detail panel", async ({ page }) => {
  await page.goto(link);
  await card(page, "MED-2").click();
  const panel = page.getByRole("complementary", { name: "MED-2 details" });
  await panel.getByLabel("Assignee").selectOption("alice");
  await panel.getByLabel("New comment").fill("<b>not bold</b> and done soon");
  await panel.getByRole("button", { name: "Comment" }).click();
  await expect(panel.locator(".comment-body")).toHaveText("<b>not bold</b> and done soon");
  await panel.getByLabel("Status").selectOption("In Progress");
  await expect.poll(() => keysIn(page, "In Progress")).toContain("MED-2");
});

test("a failing detail load reports once instead of retrying forever", async ({ page }) => {
  let loads = 0;
  await page.route("**/api/items/MED-3", (route) => {
    loads++;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ code: "internal", message: "Internal error", hint: null }),
    });
  });
  await page.goto(link);
  await card(page, "MED-3").click();
  await expect(page.getByRole("alert")).toContainText("Internal error");
  await page.waitForTimeout(1000);
  expect(loads).toBe(1);
});

test("refuses to work without the token", async ({ page }) => {
  const base = link.split("#")[0] as string;
  await page.goto(base);
  await expect(page.getByText("Open the link printed by")).toBeVisible();
  const res = await page.request.get(`${base}api/me`);
  expect(res.status()).toBe(401);
});
