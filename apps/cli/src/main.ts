#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type Actor, itemLine, ShoalError, ShoalService } from "@shoal/core";
import { type RunningServer, startWebServer } from "@shoal/http";
import { createShoalMcpServer } from "@shoal/mcp";
import { SqliteStore } from "@shoal/store-sqlite";
import { z } from "zod";

const USAGE = `Usage: shoal <command> [options]

  init --name <you> --key <KEY> [--title <collection name>]   create a workspace here
  add <title> [--type bug] [--priority high] [--assignee me] [--collection KEY]
  ls [query]                 list items (JQL-lite, e.g. "assignee = me() ORDER BY priority")
  show <key>                 item with its context
  mv <key> <status>          move an item, e.g. shoal mv MED-3 "In Progress"
  mcp                        serve MCP over stdio for your agent
  web [--port 4870]          open the kanban board in your browser (local only)

The workspace is the nearest .shoal directory, or $SHOAL_DIR.`;

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
}

const DEFAULT_WEB_DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const DEFAULT_WEB_PORT = 4870;

interface Workspace {
  dir: string;
  service: ShoalService;
  store: SqliteStore;
  config: Config;
  actor: Actor;
}

function findDir(io: Io): string | null {
  if (io.env.SHOAL_DIR) return resolve(io.cwd, io.env.SHOAL_DIR);
  for (let dir = resolve(io.cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".shoal", "config.json"))) return join(dir, ".shoal");
    if (dirname(dir) === dir) return null;
  }
}

function open(io: Io, viaAgent: boolean): Workspace {
  const dir = findDir(io);
  if (!dir || !existsSync(join(dir, "config.json"))) {
    throw new ShoalError("not_found", "No Shoal workspace here", 'Run "shoal init" first');
  }
  const config = ConfigSchema.parse(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")));
  const store = new SqliteStore(join(dir, "shoal.db"));
  const actor = { principalId: config.userId, viaAgentId: viaAgent ? config.agentId : null };
  return { dir, store, service: new ShoalService(store), config, actor };
}

function init(io: Io, values: Record<string, string | boolean | undefined>): void {
  const name = values.name;
  const key = values.key;
  if (typeof name !== "string" || typeof key !== "string") {
    throw new ShoalError(
      "invalid",
      "init needs --name and --key",
      "e.g. shoal init --name alice --key MED",
    );
  }
  const dir = io.env.SHOAL_DIR ? resolve(io.cwd, io.env.SHOAL_DIR) : join(io.cwd, ".shoal");
  if (existsSync(join(dir, "config.json"))) {
    throw new ShoalError("conflict", `A workspace already exists at ${dir}`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = new SqliteStore(join(dir, "shoal.db"));
  try {
    const service = new ShoalService(store);
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
  const server = createShoalMcpServer(ws.service, ws.actor);
  await server.connect(new StdioServerTransport());
  io.err(`shoal mcp: serving ${ws.dir} on stdio`);
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
      help: { type: "boolean", short: "h" },
    },
  });
}

async function serveWeb(io: Io, portOption: string | undefined): Promise<void> {
  const distDir = io.env.SHOAL_WEB_DIST ? resolve(io.cwd, io.env.SHOAL_WEB_DIST) : DEFAULT_WEB_DIST;
  if (!existsSync(join(distDir, "index.html"))) {
    throw new ShoalError("not_found", "The web UI is not built", "Run: pnpm build:web");
  }
  const port = portOption === undefined ? DEFAULT_WEB_PORT : Number(portOption);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ShoalError("invalid", "--port must be a whole number from 0 to 65535");
  }
  const ws = open(io, false);
  let server: RunningServer;
  try {
    server = await startWebServer({ service: ws.service, actor: ws.actor, port, distDir });
  } catch (error) {
    ws.store.close();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new ShoalError("conflict", `Port ${port} is in use`, "Pick another with --port");
    }
    throw error;
  }
  const stop = async () => {
    await server.close();
    ws.store.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  io.out(`Shoal board for ${ws.dir}`);
  // The token rides in the fragment, which browsers never send to the server.
  io.out(`Open: ${server.url}#token=${server.token}`);
  io.out("Local only. Press Ctrl+C to stop.");
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
      await serveWeb(io, values.port);
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
            throw new ShoalError("invalid", "--limit must be a whole number from 1 to 100");
          }
          const result = ws.service.search(ws.actor, args.join(" "), { limit });
          for (const item of result.items) io.out(itemLine(item));
          if (result.total > result.items.length) {
            io.out(`… ${result.total - result.items.length} more (use --limit)`);
          }
          return 0;
        }
        case "show": {
          if (!args[0]) throw new ShoalError("invalid", "show needs an item key");
          io.out(ws.service.context(args[0]));
          return 0;
        }
        case "mv": {
          const [ref, ...status] = args;
          if (!ref || status.length === 0) {
            throw new ShoalError("invalid", "mv needs an item key and a status");
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
    if (error instanceof ShoalError) {
      io.err(`error: ${error.message}${error.hint ? `\nhint: ${error.hint}` : ""}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  const io: Io = {
    cwd: process.cwd(),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  const code = await run(process.argv.slice(2), io);
  if (code !== 0) process.exitCode = code;
}
