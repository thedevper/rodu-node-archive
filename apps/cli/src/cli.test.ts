import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningServer } from "@shoal/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Io, run } from "./main.ts";

let dir: string;
let out: string[];
let err: string[];
let io: Io;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shoal-cli-"));
  out = [];
  err = [];
  io = { cwd: dir, env: {}, out: (l) => out.push(l), err: (l) => err.push(l) };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("shoal cli", () => {
  it("initialises a workspace and manages items end to end", async () => {
    expect(await run(["init", "--name", "alice", "--key", "med"], io)).toBe(0);
    expect(statSync(join(dir, ".shoal", "config.json")).mode & 0o777).toBe(0o600);

    expect(
      await run(["add", "Crash", "on", "login", "--type", "bug", "--assignee", "me"], io),
    ).toBe(0);
    expect(out.at(-1)).toBe("MED-1 [Backlog] Crash on login");

    expect(await run(["mv", "med-1", "In", "Progress"], io)).toBe(0);
    expect(out.at(-1)).toBe("MED-1 [In Progress] Crash on login");

    out = [];
    expect(await run(["ls", "assignee = me()"], { ...io, out: (l) => out.push(l) })).toBe(0);
    expect(out).toEqual(["MED-1 [In Progress] Crash on login"]);
  });

  it("finds the workspace from a subdirectory", async () => {
    await run(["init", "--name", "alice", "--key", "MED"], io);
    const sub = mkdtempSync(join(dir, "sub-"));
    expect(await run(["ls"], { ...io, cwd: sub })).toBe(0);
  });

  it("prints domain errors with hints and a non-zero exit code", async () => {
    expect(await run(["ls"], io)).toBe(1);
    expect(err.at(-1)).toContain('hint: Run "shoal init" first');

    await run(["init", "--name", "alice", "--key", "MED"], io);
    await run(["add", "Unowned"], io);
    expect(await run(["mv", "MED-1", "In Progress"], io)).toBe(1);
    expect(err.at(-1)).toContain("assign it first");
  });

  it("reports unknown options with usage instead of a stack trace", async () => {
    expect(await run(["ls", "--bogus"], io)).toBe(1);
    expect(err.at(-1)).toContain("--bogus");
    expect(err.at(-1)).toContain("Usage: shoal");
  });

  it("serves the board with a token link", async () => {
    await run(["init", "--name", "alice", "--key", "MED"], io);
    expect(await run(["web"], { ...io, env: { SHOAL_WEB_DIST: "missing-dist" } })).toBe(1);
    expect(err.at(-1)).toContain("pnpm build:web");

    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), "<title>Shoal</title>");
    let server: RunningServer | undefined;
    const code = await run(["web", "--port", "0"], {
      ...io,
      env: { SHOAL_WEB_DIST: dist },
      onWebServer: (s) => {
        server = s;
      },
    });
    expect(code).toBe(0);
    const link = out.find((l) => l.startsWith("Open: "))?.slice("Open: ".length) ?? "";
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43}$/);
    const [base, token] = link.split("#token=");
    const me = await fetch(`${base}api/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await me.json()).toEqual({ name: "alice" });
    await server?.close();
  });

  it("rejects a bad --limit without a stack trace", async () => {
    await run(["init", "--name", "alice", "--key", "MED"], io);
    expect(await run(["ls", "--limit", "abc"], io)).toBe(1);
    expect(err.at(-1)).toContain("--limit");
  });
});
