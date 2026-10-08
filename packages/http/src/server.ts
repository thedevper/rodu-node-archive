import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import {
  type Actor,
  type Collection,
  type Comment,
  type Item,
  RoduError,
  type RoduErrorCode,
  type RoduService,
} from "@rodu/core";
import { parseQuery, toSql } from "@rodu/query";
import { z } from "zod";

// The local API behind the web board. See ../README.md for the endpoint and error contract.

export interface WebServerOptions {
  service: RoduService;
  actor: Actor;
  /** 0 picks a free port. */
  port?: number;
  /** Built web UI to serve at /; null serves only the API. */
  distDir?: string | null;
  /** The built UI held in memory ("/index.html" → bytes), as a single binary carries it. */
  files?: ReadonlyMap<string, Uint8Array> | null;
  /** Fixed token for tests; a random one is generated otherwise. */
  token?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface ItemView {
  key: string;
  title: string;
  body: string;
  type: Item["type"];
  status: string;
  category: Item["category"];
  priority: Item["priority"];
  assignee: string | null;
  estimate: number | null;
  due: string | null;
  rank: string;
  version: number;
}

export interface CollectionView {
  key: string;
  name: string;
  states: Collection["workflow"]["states"];
}

const MAX_BODY_BYTES = 1024 * 1024;
const BOARD_PAGE = 100;
const BOARD_MAX_ITEMS = 1000;

const STATUS: Record<RoduErrorCode, number> = {
  invalid: 400,
  limit: 400,
  not_found: 404,
  conflict: 409,
  rule_violation: 422,
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** An HTTP-level failure (auth, size, routing) with the same JSON shape as domain errors. */
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const Ref = z.string().min(1).max(100);
const CreateBody = z
  .object({
    collection: z.string().min(1).max(20),
    item: z.unknown(),
    status: z.string().min(1).max(40).optional(),
  })
  .strict();
const PatchBody = z
  .object({ patch: z.unknown(), expectedVersion: z.number().int().min(1).optional() })
  .strict();
const TransitionBody = z
  .object({ to: z.string().min(1).max(40), after: Ref.nullish(), before: Ref.nullish() })
  .strict();
const MoveBody = z.object({ after: Ref.nullish(), before: Ref.nullish() }).strict();
const CommentBody = z.object({ body: z.string().min(1).max(20_000) }).strict();

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
  throw new RoduError("invalid", `Invalid request: ${issues.join("; ")}`);
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

export async function startWebServer(options: WebServerOptions): Promise<RunningServer> {
  const { service, actor } = options;
  const token = options.token ?? randomBytes(32).toString("base64url");
  const tokenDigest = digest(token);
  const distDir = options.distDir ? resolve(options.distDir) : null;
  const files = options.files ?? null;
  let allowedHosts: string[] = [];

  const name = (id: string | null): string | null =>
    id ? (service.store.findPrincipal(id)?.name ?? null) : null;

  const itemView = (item: Item): ItemView => ({
    key: item.key,
    title: item.title,
    body: item.body,
    type: item.type,
    status: item.status,
    category: item.category,
    priority: item.priority,
    assignee: name(item.assigneeId),
    estimate: item.estimate,
    due: item.dueAt,
    rank: item.rank,
    version: item.version,
  });

  const commentView = (c: Comment) => ({
    id: c.id,
    author: name(c.authorId) ?? "unknown",
    via: name(c.viaAgentId),
    body: c.body,
    createdAt: c.createdAt,
  });

  const collectionView = (c: Collection): CollectionView => ({
    key: c.key,
    name: c.name,
    states: c.workflow.states,
  });

  function board(collectionRef: string, filter: string) {
    const collection = service.collection(collectionRef);
    let query = `collection = "${collection.key}"`;
    if (filter.trim()) {
      // The filter must stand alone (balanced, no ORDER BY) so it cannot escape the collection scope.
      // Compile it alone first so errors point into the user's text, not the scoped query.
      toSql(filter, { me: actor.principalId, now: new Date() });
      if (parseQuery(filter).orderBy.length > 0) {
        throw new RoduError("invalid", "The board orders cards itself", "Remove ORDER BY");
      }
      query += ` AND (${filter})`;
    }
    query += " ORDER BY rank";
    // One read snapshot so concurrent writers cannot shift rows between pages, without blocking them.
    const { items, total } = service.store.transaction(() => {
      const items: Item[] = [];
      let total = 0;
      while (items.length < BOARD_MAX_ITEMS) {
        const page = service.search(actor, query, { limit: BOARD_PAGE, offset: items.length });
        total = page.total;
        items.push(...page.items);
        if (page.items.length < BOARD_PAGE) break;
      }
      return { items, total };
    }, "read");
    return { collection: collectionView(collection), items: items.map(itemView), total };
  }

  async function api(method: string, path: string, url: URL, req: IncomingMessage) {
    const item = /^\/api\/items\/([^/]+)(\/[a-z]+)?$/.exec(path);
    const action = item?.[2] ?? "";
    // Resolve the route before reading any body, so unknown paths are 404 whatever they send.
    const allowed = ["/api/me", "/api/collections", "/api/principals", "/api/board"].includes(path)
      ? ["GET"]
      : path === "/api/items"
        ? ["POST"]
        : item && action === ""
          ? ["GET", "PATCH"]
          : item && ["/transition", "/move", "/comments"].includes(action)
            ? ["POST"]
            : null;
    if (!allowed) throw new HttpError(404, "not_found", `No route ${method} ${path}`);
    if (!allowed.includes(method)) {
      throw new HttpError(
        405,
        "invalid",
        `${method} is not allowed here; use ${allowed.join(" or ")}`,
      );
    }
    let key: string | null = null;
    if (item) {
      try {
        key = decodeURIComponent(item[1] as string);
      } catch {
        throw new HttpError(400, "invalid", "Bad item key");
      }
    }
    const body = method === "POST" || method === "PATCH" ? await readJson(req) : undefined;

    if (method === "GET" && path === "/api/me") {
      return { status: 200, data: { name: name(actor.principalId) } };
    }
    if (method === "GET" && path === "/api/collections") {
      return { status: 200, data: service.listCollections().map(collectionView) };
    }
    if (method === "GET" && path === "/api/principals") {
      const people = service.store.listPrincipals().map((p) => ({ name: p.name, kind: p.kind }));
      return { status: 200, data: people };
    }
    if (method === "GET" && path === "/api/board") {
      const collection = url.searchParams.get("collection");
      if (!collection) throw new RoduError("invalid", "collection is required");
      return { status: 200, data: board(collection, url.searchParams.get("q") ?? "") };
    }
    if (method === "POST" && path === "/api/items") {
      const input = parseBody(CreateBody, body);
      // Created straight into a column: if the workflow refuses that status, nothing is created.
      const created = service.store.transaction(() => {
        const [made] = service.createItems(actor, input.collection, [input.item]);
        if (!made || !input.status || made.status.toLowerCase() === input.status.toLowerCase()) {
          return made;
        }
        return service.transition(actor, made.key, input.status);
      });
      return { status: 201, data: created ? itemView(created) : null };
    }
    if (key && action === "" && method === "GET") {
      const found = service.item(key);
      return {
        status: 200,
        data: {
          item: itemView(found),
          comments: service.store.listComments(found.id).map(commentView),
        },
      };
    }
    if (key && action === "" && method === "PATCH") {
      const input = parseBody(PatchBody, body);
      return {
        status: 200,
        data: itemView(service.updateItem(actor, key, input.patch, input.expectedVersion)),
      };
    }
    if (key && action === "/transition" && method === "POST") {
      const input = parseBody(TransitionBody, body);
      // A drop into another column changes status and position together, or neither.
      const moved = service.store.transaction(() => {
        const next = service.transition(actor, key as string, input.to);
        if (!input.after && !input.before) return next;
        return service.moveItem(actor, next.key, { after: input.after, before: input.before });
      });
      return { status: 200, data: itemView(moved) };
    }
    if (key && action === "/move" && method === "POST") {
      const input = parseBody(MoveBody, body);
      return { status: 200, data: itemView(service.moveItem(actor, key, input)) };
    }
    if (key && action === "/comments" && method === "POST") {
      const input = parseBody(CommentBody, body);
      return { status: 201, data: commentView(service.comment(actor, key, input.body)) };
    }
    throw new HttpError(404, "not_found", `No route ${method} ${path}`);
  }

  /** The file for a URL path from the in-memory UI: exact names only, so no traversal. */
  function embedded(decoded: string): { file: string; content: Uint8Array } | null {
    if (!files) return null;
    const content = files.get(decoded);
    if (content) return { file: decoded, content };
    if (extname(decoded)) throw new HttpError(404, "not_found", "Not found");
    const index = files.get("/index.html");
    return index ? { file: "/index.html", content: index } : null;
  }

  async function serveStatic(path: string, res: ServerResponse): Promise<void> {
    if (!distDir && !files) throw new HttpError(404, "not_found", "The web UI is not built");
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new HttpError(400, "invalid", "Bad path");
    }
    const found = files ? embedded(decoded) : await fromDisk(distDir as string, decoded);
    if (!found) throw new HttpError(404, "not_found", "Not found");
    const { file, content } = found;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": file.endsWith("index.html")
        ? "no-store"
        : "public, max-age=31536000, immutable",
    });
    res.end(content);
  }

  async function fromDisk(
    distDir: string,
    decoded: string,
  ): Promise<{ file: string; content: Uint8Array } | null> {
    const target = resolve(distDir, `.${decoded}`);
    if (target !== distDir && !target.startsWith(distDir + sep)) {
      throw new HttpError(404, "not_found", "Not found");
    }
    let file = target;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      // Unknown paths without an extension are app routes: serve the single page.
      if (extname(decoded)) throw new HttpError(404, "not_found", "Not found");
      file = resolve(distDir, "index.html");
    }
    const content = await readFile(file).catch(() => null);
    return content ? { file, content } : null;
  }

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer (\S+)$/.exec(header);
    if (!match) return false;
    return timingSafeEqual(digest(match[1] as string), tokenDigest);
  }

  const server = createServer(async (req, res) => {
    try {
      // Only exact local hosts: a DNS-rebinding page arrives with its own host name.
      if (!allowedHosts.includes(req.headers.host ?? "")) {
        throw new HttpError(403, "forbidden", "Unexpected Host header");
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      if (url.pathname.startsWith("/api/")) {
        if (!authorized(req)) throw new HttpError(401, "unauthorized", "Missing or wrong token");
        const { status, data } = await api(method, url.pathname, url, req);
        sendJson(res, status, data);
        return;
      }
      if (method !== "GET" && method !== "HEAD")
        throw new HttpError(405, "invalid", "Method not allowed");
      await serveStatic(url.pathname, res);
    } catch (error) {
      sendError(res, error);
    }
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : 0);
    });
  });
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    close: () =>
      new Promise<void>((done, fail) => {
        server.closeAllConnections();
        server.close((err) => (err ? fail(err) : done()));
      }),
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json(;|$)/i.test(type)) {
    throw new HttpError(415, "invalid", "Send JSON with Content-Type: application/json");
  }
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Request body is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Request body is too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid", "Body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof RoduError) {
    sendJson(res, STATUS[error.code], {
      code: error.code,
      message: error.message,
      hint: error.hint,
    });
  } else if (error instanceof HttpError) {
    sendJson(res, error.status, { code: error.code, message: error.message, hint: null });
  } else {
    // Unexpected failures stay generic so paths and SQL never reach the page.
    sendJson(res, 500, { code: "internal", message: "Internal error", hint: null });
  }
}
