import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShoalService } from "@shoal/core";
import { SqliteStore } from "@shoal/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RunningServer, startWebServer } from "./server.ts";

const TOKEN = "test-token-0123456789";
let server: RunningServer;
let dist: string;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw request so tests can set Host and other headers fetch() would not allow. */
function send(
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; raw?: string } = {},
): Promise<Reply> {
  const payload =
    options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const headers: Record<string, string> = {
    Host: `127.0.0.1:${server.port}`,
    Authorization: `Bearer ${TOKEN}`,
    ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server.port, method, path, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const json = (r: Reply) => JSON.parse(r.body);

beforeEach(async () => {
  const service = new ShoalService(new SqliteStore());
  const human = service.createPrincipal({ name: "alice", kind: "human" });
  const actor = { principalId: human.id, viaAgentId: null };
  service.createCollection(actor, { key: "MED", name: "Medical app" });
  service.createCollection(actor, { key: "OPS", name: "Ops" });
  service.createItems(actor, "OPS", [{ title: "Secret ops item" }]);
  dist = mkdtempSync(join(tmpdir(), "shoal-dist-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Shoal</title>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
  server = await startWebServer({ service, actor, distDir: dist, token: TOKEN });
});

afterEach(async () => {
  await server.close();
  rmSync(dist, { recursive: true, force: true });
});

describe("security", () => {
  it("binds to loopback and reports the URL", () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
  });

  it("requires the token on the API", async () => {
    expect((await send("GET", "/api/me", { headers: { Authorization: "" } })).status).toBe(401);
    const wrong = await send("GET", "/api/me", { headers: { Authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    expect(json(wrong)).toEqual({
      code: "unauthorized",
      message: "Missing or wrong token",
      hint: null,
    });
    expect(json(await send("GET", "/api/me"))).toEqual({ name: "alice" });
  });

  it("rejects foreign Host headers, even with the token", async () => {
    const rebound = await send("GET", "/api/me", {
      headers: { Host: `evil.example:${server.port}` },
    });
    expect(rebound.status).toBe(403);
    const page = await send("GET", "/", { headers: { Host: "evil.example" } });
    expect(page.status).toBe(403);
    expect(
      (await send("GET", "/api/me", { headers: { Host: `localhost:${server.port}` } })).status,
    ).toBe(200);
  });

  it("requires JSON and limits body size", async () => {
    const form = await send("POST", "/api/items", {
      raw: "collection=MED",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(form.status).toBe(415);
    const big = await send("POST", "/api/items", { raw: `"${"x".repeat(1024 * 1024 + 10)}"` });
    expect(big.status).toBe(413);
    expect((await send("POST", "/api/items", { raw: "{nope" })).status).toBe(400);
  });

  it("serves the UI with security headers and blocks path traversal", async () => {
    const page = await send("GET", "/", { headers: { Authorization: "" } });
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect((await send("GET", "/board/MED")).body).toContain("<title>Shoal</title>");
    expect((await send("GET", "/assets/app.js")).headers["content-type"]).toContain("javascript");
    expect((await send("GET", "/../package.json")).status).toBe(404);
    // Dot segments are normalised away, so this lands on the app page, never on /etc/passwd.
    const traversal = await send("GET", "/%2e%2e/%2e%2e/etc/passwd");
    expect(traversal.body).not.toContain("root:");
    expect(traversal.body).toContain("<title>Shoal</title>");
    expect((await send("GET", "/missing.js")).status).toBe(404);
  });

  it("rejects malformed item keys as a bad request", async () => {
    const res = await send("GET", "/api/items/%E0%A4%A");
    expect(res.status).toBe(400);
    expect(json(res).code).toBe("invalid");
  });
});

describe("board API", () => {
  it("creates, lists, moves and comments on items", async () => {
    for (const title of ["Login", "Logout", "Export"]) {
      const created = await send("POST", "/api/items", {
        body: { collection: "MED", item: { title } },
      });
      expect(created.status).toBe(201);
    }
    const board = json(await send("GET", "/api/board?collection=med"));
    expect(board.collection.states.map((s: { name: string }) => s.name)).toContain("In Review");
    expect(board.items.map((i: { key: string }) => i.key)).toEqual(["MED-1", "MED-2", "MED-3"]);

    const moved = await send("POST", "/api/items/MED-3/move", { body: { before: "MED-1" } });
    expect(json(moved).version).toBe(2);
    const reordered = json(await send("GET", "/api/board?collection=MED"));
    expect(reordered.items.map((i: { key: string }) => i.key)).toEqual(["MED-3", "MED-1", "MED-2"]);

    await send("POST", "/api/items/MED-1/comments", { body: { body: "Looks good" } });
    const detail = json(await send("GET", "/api/items/MED-1"));
    expect(detail.comments[0]).toMatchObject({ author: "alice", body: "Looks good" });
  });

  it("maps workflow refusals to 422 with the hint", async () => {
    await send("POST", "/api/items", { body: { collection: "MED", item: { title: "Unowned" } } });
    const refused = await send("POST", "/api/items/MED-1/transition", {
      body: { to: "In Progress" },
    });
    expect(refused.status).toBe(422);
    expect(json(refused)).toMatchObject({ code: "rule_violation" });
    expect(json(refused).hint).toContain("assign it first");

    await send("PATCH", "/api/items/MED-1", {
      body: { patch: { assignee: "me" }, expectedVersion: 1 },
    });
    const stale = await send("PATCH", "/api/items/MED-1", {
      body: { patch: { title: "X" }, expectedVersion: 1 },
    });
    expect(stale.status).toBe(409);
    const ok = await send("POST", "/api/items/MED-1/transition", { body: { to: "In Progress" } });
    expect(json(ok).status).toBe("In Progress");
  });

  it("scopes the board filter to the collection", async () => {
    await send("POST", "/api/items", { body: { collection: "MED", item: { title: "Mine" } } });
    const breakout = await send(
      "GET",
      `/api/board?collection=MED&q=${encodeURIComponent('title ~ "x") OR (title ~ "Secret"')}`,
    );
    expect(breakout.status).toBe(400);
    const ordered = await send(
      "GET",
      `/api/board?collection=MED&q=${encodeURIComponent("ORDER BY title")}`,
    );
    expect(ordered.status).toBe(400);
    const filtered = json(
      await send("GET", `/api/board?collection=MED&q=${encodeURIComponent('title ~ "zzz"')}`),
    );
    expect(filtered.items.map((i: { title: string }) => i.title)).toEqual([]);
    const all = json(
      await send("GET", `/api/board?collection=MED&q=${encodeURIComponent("type = task")}`),
    );
    expect(all.items.map((i: { key: string }) => i.key)).toEqual(["MED-1"]);
  });

  it("moves a card into a column at a position in one step, or not at all", async () => {
    for (const title of ["A", "B", "C"]) {
      await send("POST", "/api/items", {
        body: { collection: "MED", item: { title, assignee: "me" } },
      });
    }
    await send("POST", "/api/items/MED-1/transition", { body: { to: "In Progress" } });
    await send("POST", "/api/items/MED-2/transition", { body: { to: "In Progress" } });
    const placed = await send("POST", "/api/items/MED-3/transition", {
      body: { to: "In Progress", before: "MED-1" },
    });
    expect(placed.status).toBe(200);
    const board = json(await send("GET", "/api/board?collection=MED"));
    const inProgress = board.items.filter((i: { status: string }) => i.status === "In Progress");
    expect(inProgress.map((i: { key: string }) => i.key)).toEqual(["MED-3", "MED-1", "MED-2"]);

    await send("POST", "/api/items", {
      body: { collection: "MED", item: { title: "D", assignee: "me" } },
    });
    const failed = await send("POST", "/api/items/MED-4/transition", {
      body: { to: "In Progress", before: "OPS-1" },
    });
    expect(failed.status).toBe(400);
    expect(json(await send("GET", "/api/items/MED-4")).item.status).toBe("Backlog");
  });

  it("reports filter errors against the user's own filter", async () => {
    const res = await send(
      "GET",
      `/api/board?collection=MED&q=${encodeURIComponent("nosuchfield = 1")}`,
    );
    expect(res.status).toBe(400);
    expect(json(res).message).toContain("Query error at 0");
    expect(json(res).hint).not.toContain('collection = "MED"');
  });

  it("validates request bodies before the service", async () => {
    const res = await send("POST", "/api/items/MED-1/transition", { body: { to: "", extra: 1 } });
    expect(res.status).toBe(400);
    expect(json(res).message).toContain("Invalid request");
    expect((await send("DELETE", "/api/items/MED-1")).status).toBe(404);
  });
});
