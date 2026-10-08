// Drives a built shoal binary the way a new user would: init, add, ls, the web board and MCP.
//
//   pnpm smoke:binary [path/to/shoal]   (default: the binary built for this machine)

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HOST = process.platform === "win32" ? "windows-x64" : `${process.platform}-${process.arch}`;
const binary = resolve(
  process.argv[2] ??
    join(ROOT, "dist/sea", HOST, process.platform === "win32" ? "shoal.exe" : "shoal"),
);
if (!existsSync(binary)) throw new Error(`${binary} not found: run pnpm build:binaries`);

const cwd = mkdtempSync(join(tmpdir(), "shoal-smoke-"));
const { SHOAL_DIR: _ignored, ...env } = process.env;
const shoal = (...args: string[]) => execFileSync(binary, args, { cwd, env, encoding: "utf8" });

/** Windows will not delete a folder a live process still uses: stop it and wait. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill();
  await exited;
}

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

/** Collects a child's stdout until `until` matches, or fails after 15 s. */
function waitFor(child: ChildProcess, until: RegExp): Promise<RegExpMatchArray> {
  return new Promise((done, fail) => {
    let text = "";
    const timer = setTimeout(
      () => fail(new Error(`timed out waiting for ${until}: ${text}`)),
      15_000,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const match = text.match(until);
      if (match) {
        clearTimeout(timer);
        done(match);
      }
    });
    child.on("exit", (code) => fail(new Error(`exited ${code} before ${until}: ${text}`)));
  });
}

try {
  const version = shoal("--version").trim();
  check("--version", /^shoal \d+\.\d+\.\d+$/.test(version), version);
  shoal("init", "--name", "smoke", "--key", "SMK", "--title", "Smoke test");
  shoal("add", "First", "card", "--assignee", "me");
  const list = shoal("ls");
  check("init, add, ls", list.includes("SMK-1") && list.includes("First card"), list.trim());

  const web = spawn(binary, ["web", "--port", "0", "--no-open"], { cwd, env });
  try {
    const [, base, token] = await waitFor(web, /Open: (http:\/\/127\.0\.0\.1:\d+\/)#token=(\S+)/);
    const page = await (await fetch(base as string)).text();
    check("web serves the embedded board", page.includes('<div id="root">'), base);
    const asset = page.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    const js = asset ? await fetch(new URL(asset, base)) : null;
    check("web serves its assets", js?.status === 200, asset ?? "no script tag");
    const me = await fetch(`${base}api/me`, { headers: { Authorization: `Bearer ${token}` } });
    check("web API answers", (await me.text()).includes("smoke"));
  } finally {
    await stop(web);
  }

  const mcp = spawn(binary, ["mcp"], { cwd, env });
  try {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0" },
      },
    };
    mcp.stdin.write(`${JSON.stringify(initialize)}\n`);
    const [line] = await waitFor(mcp, /\{[^\n]*"id":1[^\n]*\}\n/);
    check("mcp initialize", line.includes('"serverInfo"'), line.trim().slice(0, 100));
  } finally {
    await stop(mcp);
  }
} finally {
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
