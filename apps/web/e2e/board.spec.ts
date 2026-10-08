import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

// End-to-end probe of `rodu web`: a throwaway workspace, the real CLI and server, and the built UI.
// Requires `pnpm build:web` first.

const CLI = resolve(import.meta.dirname, "../../cli/src/main.ts");
let dir: string;
let server: ChildProcess;
let link: string;

function rodu(...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, RODU_DIR: join(dir, ".rodu") },
    encoding: "utf8",
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rodu-e2e-"));
  rodu("init", "--name", "alice", "--key", "DEMO", "--title", "Demo project");
  rodu("add", "Fix login crash", "--type", "bug", "--priority", "urgent", "--assignee", "me");
  rodu("add", "Write onboarding doc");
  rodu("add", "Export PDF report", "--priority", "high");
  server = spawn(process.execPath, [CLI, "web", "--port", "0"], {
    env: { ...process.env, RODU_DIR: join(dir, ".rodu") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  link = await new Promise<string>((done, fail) => {
    let output = "";
    server.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = /Open: (\S+)/.exec(output);
      if (match?.[1]) done(match[1]);
    });
    server.once("exit", (code) => fail(new Error(`rodu web exited with ${code}`)));
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
  await expect.poll(() => keysIn(page, "Backlog")).toEqual(["DEMO-1", "DEMO-2", "DEMO-3"]);
  expect(page.url()).not.toContain("token");
});

test("shows the workflow refusal when moving an unassigned card into progress", async ({
  page,
}) => {
  await page.goto(link);
  await card(page, "DEMO-2").dragTo(column(page, "In Progress"));
  const alert = page.getByRole("alert");
  await expect(alert).toContainText('cannot move to "In Progress" yet');
  await expect(alert).toContainText("assign it first");
  await expect.poll(() => keysIn(page, "Backlog")).toContain("DEMO-2");
  await expect.poll(() => keysIn(page, "In Progress")).toEqual([]);
});

test("moves an assigned card to another column", async ({ page }) => {
  await page.goto(link);
  await card(page, "DEMO-1").dragTo(column(page, "In Progress"));
  await expect.poll(() => keysIn(page, "In Progress")).toEqual(["DEMO-1"]);
  expect(rodu("ls", "status = 'In Progress'").trim()).toBe(
    "DEMO-1 [In Progress] (urgent) Fix login crash",
  );
});

test("reorders cards within a column and keeps the order after reload", async ({ page }) => {
  await page.goto(link);
  await expect.poll(() => keysIn(page, "Backlog")).toEqual(["DEMO-2", "DEMO-3"]);
  await card(page, "DEMO-3").dragTo(card(page, "DEMO-2"), { targetPosition: { x: 20, y: 2 } });
  await expect.poll(() => keysIn(page, "Backlog")).toEqual(["DEMO-3", "DEMO-2"]);
  await page.reload();
  await expect.poll(() => keysIn(page, "Backlog")).toEqual(["DEMO-3", "DEMO-2"]);
});

test("filters with JQL-lite and reports bad queries", async ({ page }) => {
  await page.goto(link);
  const filter = page.getByLabel("Filter");
  await filter.fill("priority = high");
  await filter.press("Enter");
  await expect.poll(() => keysIn(page, "Backlog")).toEqual(["DEMO-3"]);
  await filter.fill("nope = 1");
  await filter.press("Enter");
  await expect(page.getByRole("alert")).toContainText('unknown field "nope"');
});

test("edits an item and comments in the detail panel", async ({ page }) => {
  await page.goto(link);
  await card(page, "DEMO-2").click();
  const panel = page.getByRole("complementary", { name: "DEMO-2 details" });
  await panel.getByLabel("Assignee").selectOption("alice");
  await panel.getByLabel("New comment").fill("<b>not bold</b> and done soon");
  await panel.getByRole("button", { name: "Comment" }).click();
  await expect(panel.locator(".comment-body")).toHaveText("<b>not bold</b> and done soon");
  await panel.getByLabel("Status").selectOption("In Progress");
  await expect.poll(() => keysIn(page, "In Progress")).toContain("DEMO-2");
});

test("adds a card straight into a column, or not at all when the workflow refuses", async ({
  page,
}) => {
  await page.goto(link);
  const todo = column(page, "Todo");
  await todo.getByRole("button", { name: "Add item to Todo" }).click();
  await todo.getByLabel("New item title").fill("Plan sprint");
  await todo.getByLabel("New item title").press("Enter");
  await expect(todo).toContainText("Plan sprint");

  const doing = column(page, "In Progress");
  await doing.getByRole("button", { name: "Add item to In Progress" }).click();
  await doing.getByLabel("New item title").fill("Nobody owns this");
  await doing.getByLabel("New item title").press("Enter");
  await expect(page.getByRole("alert")).toContainText("assign it first");
  expect(rodu("ls", 'title ~ "Nobody"').trim()).toBe("");
});

test("a failing detail load reports once instead of retrying forever", async ({ page }) => {
  let loads = 0;
  await page.route("**/api/items/DEMO-3", (route) => {
    loads++;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ code: "internal", message: "Internal error", hint: null }),
    });
  });
  await page.goto(link);
  await card(page, "DEMO-3").click();
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
