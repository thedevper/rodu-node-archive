#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import sea from "node:sea";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type Actor, itemLine, RoduError, RoduService } from "@rodu/core";
import { type RunningServer, startWebServer } from "@rodu/http";
import { createRoduMcpServer } from "@rodu/mcp";
import { SqliteStore } from "@rodu/store-sqlite";
import { z } from "zod";
import { VERSION } from "./version.ts";

const USAGE = `Usage: rodu <command> [options]

  init --name <you> --key <KEY> [--title <collection name>]   create a workspace here
  add <title> [--type bug] [--priority high] [--assignee me] [--collection KEY]
  ls [query]                 list items (JQL-lite, e.g. "assignee = me() ORDER BY priority")
  show <key>                 item with its context
  mv <key> <status>          move an item, e.g. rodu mv DEMO-3 "In Progress"
  mcp                        serve MCP over stdio for your agent
  web [--port 4870] [--no-open]   open the kanban board in your browser (local only)
  --version                  print the version

The workspace is the nearest .rodu directory, or $RODU_DIR.`;

const ConfigSchema = z.object({
  userId: z.string().min(1),
  agentId: z.string().min(1),
  collection: z.string().min(1),
});
type Config = z.infer<typeof ConfigSchema>;

export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Receives the running web server, so tests can stop it. */
  onWebServer?: (server: RunningServer) => void;
  /** Opens the board link in the user's browser; absent in tests. */
  openUrl?: (url: string) => void;
}

// From a checkout the board is apps/web/dist; a single binary carries it as "web/…" assets.
const defaultWebDist = () => resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");

function embeddedWeb(): Map<string, Uint8Array> | null {
  if (!sea.isSea()) return null;
  const files = new Map<string, Uint8Array>();
  for (const key of sea.getAssetKeys()) {
    if (key.startsWith("web/")) files.set(key.slice(3), new Uint8Array(sea.getRawAsset(key)));
  }
  return files.size > 0 ? files : null;
}
const DEFAULT_WEB_PORT = 4870;

interface Workspace {
  dir: string;
  service: RoduService;
  store: SqliteStore;
  config: Config;
  actor: Actor;
}

/** How to move a workspace made by Shoal, as Rodu was called until 0.2.0. */
function moveFromShoal(dir: string): string {
  return (
    `Stop any running shoal first (shoal web, or an agent running shoal mcp). Then, in ${dir}, ` +
    "rename the folder .shoal to .rodu, and inside it shoal.db to rodu.db, plus shoal.db-wal " +
    "and shoal.db-shm to rodu.db-wal and rodu.db-shm if they exist (they hold recent changes)."
  );
}

function refuseShoal(dir: string): void {
  if (existsSync(join(dir, ".shoal", "config.json"))) {
    throw new RoduError(
      "conflict",
      `${join(dir, ".shoal")} is from Shoal, Rodu's old name`,
      moveFromShoal(dir),
    );
  }
}

function findDir(io: Io): string | null {
  if (io.env.RODU_DIR) return resolve(io.cwd, io.env.RODU_DIR);
  for (let dir = resolve(io.cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".rodu", "config.json"))) return join(dir, ".rodu");
    refuseShoal(dir);
    if (dirname(dir) === dir) return null;
  }
}

function open(io: Io, viaAgent: boolean): Workspace {
  const dir = findDir(io);
  if (!dir || !existsSync(join(dir, "config.json"))) {
    throw new RoduError(
      "not_found",
      "No Rodu workspace here",
      'Create one in this folder: rodu init --name <you> --key <KEY> --title "<project>"',
    );
  }
  // Old WAL files always hold changes; an old database only matters when there is no new one.
  const leftover = ["shoal.db-wal", "shoal.db-shm", "shoal.db"].find(
    (f) => existsSync(join(dir, f)) && (f !== "shoal.db" || !existsSync(join(dir, "rodu.db"))),
  );
  if (leftover) {
    throw new RoduError(
      "conflict",
      `${dir} still holds ${leftover} from Shoal, Rodu's old name`,
      "Stop any running shoal first. Then, in that folder, rename shoal.db to rodu.db, plus " +
        "shoal.db-wal and shoal.db-shm to rodu.db-wal and rodu.db-shm if they exist.",
    );
  }
  const config = ConfigSchema.parse(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")));
  const store = new SqliteStore(join(dir, "rodu.db"));
  const actor = { principalId: config.userId, viaAgentId: viaAgent ? config.agentId : null };
  return { dir, store, service: new RoduService(store), config, actor };
}

function init(io: Io, values: Record<string, string | boolean | undefined>): void {
  const name = values.name;
  const key = values.key;
  if (typeof name !== "string" || typeof key !== "string") {
    throw new RoduError(
      "invalid",
      "init needs --name and --key",
      "e.g. rodu init --name your-name --key DEMO",
    );
  }
  // An old workspace above, not shadowed by a Rodu one, would look lost behind a new empty one.
  for (let up = resolve(io.cwd); ; up = dirname(up)) {
    if (existsSync(join(up, ".rodu", "config.json"))) break;
    refuseShoal(up);
    if (dirname(up) === up) break;
  }
  const dir = io.env.RODU_DIR ? resolve(io.cwd, io.env.RODU_DIR) : join(io.cwd, ".rodu");
  if (existsSync(join(dir, "config.json"))) {
    throw new RoduError("conflict", `A workspace already exists at ${dir}`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = new SqliteStore(join(dir, "rodu.db"));
  try {
    const service = new RoduService(store);
    const config = store.transaction(() => {
      const user = service.createPrincipal({ name, kind: "human" });
      const agent = service.createPrincipal({
        name: `${name}-agent`,
        kind: "agent",
        ownerId: user.id,
      });
      const actor = { principalId: user.id, viaAgentId: null };
      const title = typeof values.title === "string" ? values.title : key.toUpperCase();
      const collection = service.createCollection(actor, { key, name: title });
      return { userId: user.id, agentId: agent.id, collection: collection.key };
    });
    writeFileSync(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    io.out(`Created ${dir} with collection ${config.collection}`);
  } finally {
    store.close();
  }
}

async function serveMcp(io: Io): Promise<void> {
  const ws = open(io, true);
  const server = createRoduMcpServer(ws.service, ws.actor);
  await server.connect(new StdioServerTransport());
  io.err(`rodu mcp: serving ${ws.dir} on stdio`);
}

function parseOptions(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      key: { type: "string" },
      title: { type: "string" },
      type: { type: "string" },
      priority: { type: "string" },
      assignee: { type: "string" },
      collection: { type: "string", short: "c" },
      limit: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
}

async function serveWeb(
  io: Io,
  portOption: string | undefined,
  openBrowser: boolean,
): Promise<void> {
  const files = io.env.RODU_WEB_DIST ? null : embeddedWeb();
  const distDir = files
    ? null
    : io.env.RODU_WEB_DIST
      ? resolve(io.cwd, io.env.RODU_WEB_DIST)
      : defaultWebDist();
  if (distDir && !existsSync(join(distDir, "index.html"))) {
    throw new RoduError(
      "not_found",
      "The web UI is not built",
      sea.isSea() ? "This rodu binary is incomplete: reinstall it" : "Run: pnpm build:web",
    );
  }
  const port = portOption === undefined ? DEFAULT_WEB_PORT : Number(portOption);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RoduError("invalid", "--port must be a whole number from 0 to 65535");
  }
  const ws = open(io, false);
  let server: RunningServer;
  try {
    server = await startWebServer({ service: ws.service, actor: ws.actor, port, distDir, files });
  } catch (error) {
    ws.store.close();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new RoduError("conflict", `Port ${port} is in use`, "Pick another with --port");
    }
    throw error;
  }
  // Idempotent: Ctrl+C after close(), or SIGINT then SIGTERM, must not close twice.
  let stopping: Promise<void> | null = null;
  const onSignal = () => void stop();
  const stop = () => {
    stopping ??= (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      try {
        await server.close();
      } finally {
        ws.store.close();
      }
    })();
    return stopping;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  io.out(`Rodu board for ${ws.dir}`);
  // The token rides in the fragment, which browsers never send to the server.
  const link = `${server.url}#token=${server.token}`;
  io.out(`Open: ${link}`);
  io.out("Local only. Press Ctrl+C to stop.");
  if (openBrowser) io.openUrl?.(link);
  io.onWebServer?.({ ...server, close: stop });
}

export async function run(argv: string[], io: Io): Promise<number> {
  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(argv);
  } catch (error) {
    // parseArgs rejects unknown or malformed options with a plain message: show it with usage.
    if (
      error instanceof TypeError &&
      "code" in error &&
      String(error.code).startsWith("ERR_PARSE_ARGS")
    ) {
      io.err(`error: ${error.message}\n\n${USAGE}`);
      return 1;
    }
    throw error;
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  if (values.version) {
    io.out(`rodu ${VERSION}`);
    return 0;
  }
  if (!command || values.help) {
    io.out(USAGE);
    return command || values.help ? 0 : 1;
  }
  try {
    if (command === "init") {
      init(io, values);
      return 0;
    }
    if (command === "mcp") {
      await serveMcp(io);
      return 0;
    }
    if (command === "web") {
      await serveWeb(io, values.port, !values["no-open"]);
      return 0;
    }
    const ws = open(io, false);
    try {
      switch (command) {
        case "add": {
          const title = args.join(" ");
          const [item] = ws.service.createItems(
            ws.actor,
            values.collection ?? ws.config.collection,
            [{ title, type: values.type, priority: values.priority, assignee: values.assignee }],
          );
          if (item) io.out(itemLine(item));
          return 0;
        }
        case "ls": {
          const limit = values.limit === undefined ? 50 : Number(values.limit);
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new RoduError("invalid", "--limit must be a whole number from 1 to 100");
          }
          const result = ws.service.search(ws.actor, args.join(" "), { limit });
          for (const item of result.items) io.out(itemLine(item));
          if (result.total > result.items.length) {
            io.out(`… ${result.total - result.items.length} more (use --limit)`);
          }
          return 0;
        }
        case "show": {
          if (!args[0]) throw new RoduError("invalid", "show needs an item key");
          io.out(ws.service.context(args[0]));
          return 0;
        }
        case "mv": {
          const [ref, ...status] = args;
          if (!ref || status.length === 0) {
            throw new RoduError("invalid", "mv needs an item key and a status");
          }
          io.out(itemLine(ws.service.transition(ws.actor, ref, status.join(" "))));
          return 0;
        }
        default:
          io.err(`Unknown command "${command}"\n\n${USAGE}`);
          return 1;
      }
    } finally {
      ws.store.close();
    }
  } catch (error) {
    if (error instanceof RoduError) {
      io.err(`error: ${error.message}${error.hint ? `\nhint: ${error.hint}` : ""}`);
      return 1;
    }
    throw error;
  }
}

/** Best effort: the link is printed too, so a missing opener only costs a copy and paste. */
function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // The default browser via the shell, without cmd.exe and its quoting rules.
          ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed link still works.
  }
}

if (import.meta.main) {
  const io: Io = {
    cwd: process.cwd(),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    openUrl,
  };
  const code = await run(process.argv.slice(2), io);
  if (code !== 0) process.exitCode = code;
}
