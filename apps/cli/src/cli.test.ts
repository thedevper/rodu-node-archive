import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningServer } from "@rodu/http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Io, run } from "./main.ts";

let dir: string;
let out: string[];
let err: string[];
let io: Io;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rodu-cli-"));
  out = [];
  err = [];
  io = { cwd: dir, env: {}, out: (l) => out.push(l), err: (l) => err.push(l) };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("rodu cli", () => {
  it("initialises a workspace and manages items end to end", async () => {
    expect(await run(["init", "--name", "alice", "--key", "demo"], io)).toBe(0);
    // Windows has no POSIX modes; the file sits in the user's own profile there.
    if (process.platform !== "win32") {
      expect(statSync(join(dir, ".rodu", "config.json")).mode & 0o777).toBe(0o600);
    }

    expect(
      await run(["add", "Crash", "on", "login", "--type", "bug", "--assignee", "me"], io),
    ).toBe(0);
    expect(out.at(-1)).toBe("DEMO-1 [Backlog] Crash on login");

    expect(await run(["mv", "demo-1", "In", "Progress"], io)).toBe(0);
    expect(out.at(-1)).toBe("DEMO-1 [In Progress] Crash on login");

    out = [];
    expect(await run(["ls", "assignee = me()"], { ...io, out: (l) => out.push(l) })).toBe(0);
    expect(out).toEqual(["DEMO-1 [In Progress] Crash on login"]);
  });

  it("finds the workspace from a subdirectory", async () => {
    await run(["init", "--name", "alice", "--key", "DEMO"], io);
    const sub = mkdtempSync(join(dir, "sub-"));
    expect(await run(["ls"], { ...io, cwd: sub })).toBe(0);
  });

  it("explains how to move a workspace made before the rename", async () => {
    await run(["init", "--name", "alice", "--key", "DEMO"], io);
    renameSync(join(dir, ".rodu", "rodu.db"), join(dir, ".rodu", "shoal.db"));
    renameSync(join(dir, ".rodu"), join(dir, ".shoal"));
    const sub = mkdtempSync(join(dir, "sub-"));

    expect(await run(["ls"], { ...io, cwd: sub })).toBe(1);
    expect(err.at(-1)).toContain(`${join(dir, ".shoal")} is from Shoal`);
    expect(err.at(-1)).toContain("Stop any running shoal first");
    expect(err.at(-1)).toContain("shoal.db-wal");

    // init would otherwise start an empty workspace beside the old one.
    expect(await run(["init", "--name", "alice", "--key", "DEMO"], io)).toBe(1);
    expect(err.at(-1)).toContain("is from Shoal");
    expect(existsSync(join(dir, ".rodu"))).toBe(false);

    // Half moved: the folder is renamed but the database is not.
    renameSync(join(dir, ".shoal"), join(dir, ".rodu"));
    expect(await run(["ls"], { ...io, cwd: sub })).toBe(1);
    expect(err.at(-1)).toContain("still holds shoal.db");
    expect(existsSync(join(dir, ".rodu", "rodu.db"))).toBe(false);

    renameSync(join(dir, ".rodu", "shoal.db"), join(dir, ".rodu", "rodu.db"));
    expect(await run(["ls"], { ...io, cwd: sub })).toBe(0);
  });

  it("prints domain errors with hints and a non-zero exit code", async () => {
    expect(await run(["ls"], io)).toBe(1);
    expect(err.at(-1)).toContain("hint: Create one in this folder: rodu init");

    await run(["init", "--name", "alice", "--key", "DEMO"], io);
    await run(["add", "Unowned"], io);
    expect(await run(["mv", "DEMO-1", "In Progress"], io)).toBe(1);
    expect(err.at(-1)).toContain("assign it first");
  });

  it("reports unknown options with usage instead of a stack trace", async () => {
    expect(await run(["ls", "--bogus"], io)).toBe(1);
    expect(err.at(-1)).toContain("--bogus");
    expect(err.at(-1)).toContain("Usage: rodu");
  });

  it("serves the board with a token link", async () => {
    const sigints = process.listenerCount("SIGINT");
    await run(["init", "--name", "alice", "--key", "DEMO"], io);
    expect(await run(["web"], { ...io, env: { RODU_WEB_DIST: "missing-dist" } })).toBe(1);
    expect(err.at(-1)).toContain("pnpm build:web");

    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), "<title>Rodu</title>");
    let server: RunningServer | undefined;
    const code = await run(["web", "--port", "0"], {
      ...io,
      env: { RODU_WEB_DIST: dist },
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

    const port = new URL(base as string).port;
    expect(await run(["web", "--port", port], { ...io, env: { RODU_WEB_DIST: dist } })).toBe(1);
    expect(err.at(-1)).toContain(`Port ${port} is in use`);
    expect(await run(["web", "--port", "abc"], { ...io, env: { RODU_WEB_DIST: dist } })).toBe(1);
    expect(err.at(-1)).toContain("--port");

    await server?.close();
    // Stopping twice (Ctrl+C after close) is harmless, and no signal handlers are left behind.
    await expect(server?.close()).resolves.toBeUndefined();
    expect(process.listenerCount("SIGINT")).toBe(sigints);
  });

  it("opens the board in the browser unless told not to", async () => {
    await run(["init", "--name", "alice", "--key", "DEMO"], io);
    const dist = join(dir, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), "<title>Rodu</title>");
    const opened: string[] = [];
    const servers: RunningServer[] = [];
    const web = { ...io, env: { RODU_WEB_DIST: dist }, openUrl: (u: string) => opened.push(u) };
    const onWebServer = (s: RunningServer) => servers.push(s);
    expect(await run(["web", "--port", "0"], { ...web, onWebServer })).toBe(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=/);
    expect(await run(["web", "--port", "0", "--no-open"], { ...web, onWebServer })).toBe(0);
    expect(opened).toHaveLength(1);
    for (const s of servers) await s.close();
  });

  it("prints its version", async () => {
    expect(await run(["--version"], io)).toBe(0);
    expect(out.at(-1)).toMatch(/^rodu \d+\.\d+\.\d+$/);
  });

  it("tells a new user how to start", async () => {
    expect(await run(["ls"], io)).toBe(1);
    expect(err.at(-1)).toContain("rodu init --name");
  });

  it("rejects a bad --limit without a stack trace", async () => {
    await run(["init", "--name", "alice", "--key", "DEMO"], io);
    expect(await run(["ls", "--limit", "abc"], io)).toBe(1);
    expect(err.at(-1)).toContain("--limit");
  });
});
