import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  Collection,
  Comment,
  Cycle,
  Item,
  Link,
  Principal,
  SearchRequest,
  SearchResult,
  ShoalEvent,
  Store,
} from "@shoal/core";
import { toSql } from "@shoal/query";

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  owner_id TEXT REFERENCES principals(id)
);
CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  preset TEXT NOT NULL,
  workflow TEXT NOT NULL,
  created_at TEXT NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE cycles (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  name TEXT NOT NULL,
  starts_on TEXT,
  ends_on TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned', 'active', 'closed')),
  UNIQUE (collection_id, name COLLATE NOCASE)
);
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id),
  number INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  assignee_id TEXT REFERENCES principals(id),
  parent_id TEXT REFERENCES items(id),
  cycle_id TEXT REFERENCES cycles(id),
  estimate REAL,
  rank TEXT NOT NULL,
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL,
  UNIQUE (collection_id, number)
);
CREATE INDEX items_rank ON items (collection_id, rank);
CREATE INDEX items_assignee ON items (assignee_id);
CREATE INDEX items_cycle ON items (cycle_id);
CREATE INDEX items_parent ON items (parent_id);
CREATE VIRTUAL TABLE items_fts USING fts5 (item_id UNINDEXED, title, body);
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  author_id TEXT NOT NULL REFERENCES principals(id),
  via_agent_id TEXT REFERENCES principals(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX comments_item ON comments (item_id, created_at);
CREATE TABLE links (
  id TEXT PRIMARY KEY,
  from_item_id TEXT NOT NULL REFERENCES items(id),
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (from_item_id, kind, target)
);
CREATE INDEX links_target ON links (target);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  via_agent_id TEXT,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before TEXT,
  after TEXT,
  at TEXT NOT NULL
);
CREATE INDEX events_target ON events (target_id, seq);
CREATE TABLE idempotency (
  key TEXT PRIMARY KEY,
  result TEXT NOT NULL
);
`;

type Row = Record<string, SQLInputValue>;

const str = (v: SQLInputValue | undefined): string => String(v);
const optStr = (v: SQLInputValue | undefined): string | null =>
  v === null || v === undefined ? null : String(v);
const optNum = (v: SQLInputValue | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

function toPrincipal(r: Row): Principal {
  return {
    id: str(r.id),
    kind: str(r.kind) as Principal["kind"],
    name: str(r.name),
    ownerId: optStr(r.owner_id),
  };
}

function toCollection(r: Row): Collection {
  return {
    id: str(r.id),
    key: str(r.key),
    name: str(r.name),
    preset: str(r.preset) as Collection["preset"],
    workflow: JSON.parse(str(r.workflow)) as Collection["workflow"],
    createdAt: str(r.created_at),
  };
}

function toCycle(r: Row): Cycle {
  return {
    id: str(r.id),
    collectionId: str(r.collection_id),
    name: str(r.name),
    startsOn: optStr(r.starts_on),
    endsOn: optStr(r.ends_on),
    state: str(r.state) as Cycle["state"],
  };
}

function toItem(r: Row): Item {
  return {
    id: str(r.id),
    collectionId: str(r.collection_id),
    number: Number(r.number),
    key: str(r.key),
    type: str(r.type) as Item["type"],
    title: str(r.title),
    body: str(r.body),
    status: str(r.status),
    category: str(r.category) as Item["category"],
    priority: str(r.priority) as Item["priority"],
    assigneeId: optStr(r.assignee_id),
    parentId: optStr(r.parent_id),
    cycleId: optStr(r.cycle_id),
    estimate: optNum(r.estimate),
    rank: str(r.rank),
    dueAt: optStr(r.due_at),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    version: Number(r.version),
  };
}

function toComment(r: Row): Comment {
  return {
    id: str(r.id),
    itemId: str(r.item_id),
    authorId: str(r.author_id),
    viaAgentId: optStr(r.via_agent_id),
    body: str(r.body),
    createdAt: str(r.created_at),
  };
}

function toLink(r: Row): Link {
  return {
    id: str(r.id),
    fromItemId: str(r.from_item_id),
    kind: str(r.kind) as Link["kind"],
    target: str(r.target),
    createdAt: str(r.created_at),
  };
}

function toEvent(r: Row): ShoalEvent {
  return {
    id: str(r.id),
    requestId: str(r.request_id),
    actorId: str(r.actor_id),
    viaAgentId: optStr(r.via_agent_id),
    action: str(r.action),
    targetId: str(r.target_id),
    before: JSON.parse(str(r.before ?? "null")),
    after: JSON.parse(str(r.after ?? "null")),
    at: str(r.at),
  };
}

/** The v0 local store: one SQLite file per workspace, using Node's built-in driver. */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private depth = 0;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = Number(this.one("PRAGMA user_version")?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(`Database schema ${version} is newer than this Shoal (${SCHEMA_VERSION})`);
    }
    if (version === 0) {
      this.transaction(() => {
        this.db.exec(SCHEMA);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
  }

  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  transaction<T>(fn: () => T, mode?: "read"): T {
    const outer = this.depth === 0;
    const savepoint = `sp${this.depth}`;
    const begin = mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE";
    this.db.exec(outer ? begin : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      this.db.exec(outer ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      // Also reached when COMMIT itself fails (e.g. SQLITE_BUSY): never leave a transaction open.
      if (this.db.isTransaction) {
        this.db.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      }
      throw error;
    } finally {
      this.depth--;
    }
  }

  // --- principals ---

  insertPrincipal(p: Principal): void {
    this.run(
      "INSERT INTO principals (id, kind, name, owner_id) VALUES (?, ?, ?, ?)",
      p.id,
      p.kind,
      p.name,
      p.ownerId,
    );
  }

  findPrincipal(idOrName: string): Principal | null {
    const row =
      this.one("SELECT * FROM principals WHERE id = ?", idOrName) ??
      this.one("SELECT * FROM principals WHERE name = ?", idOrName);
    return row ? toPrincipal(row) : null;
  }

  listPrincipals(): Principal[] {
    return this.all("SELECT * FROM principals ORDER BY name").map(toPrincipal);
  }

  // --- collections ---

  insertCollection(c: Collection): void {
    this.run(
      "INSERT INTO collections (id, key, name, preset, workflow, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      c.id,
      c.key,
      c.name,
      c.preset,
      JSON.stringify(c.workflow),
      c.createdAt,
    );
  }

  findCollection(idOrKey: string): Collection | null {
    const row =
      this.one("SELECT * FROM collections WHERE id = ?", idOrKey) ??
      this.one("SELECT * FROM collections WHERE key = ?", idOrKey);
    return row ? toCollection(row) : null;
  }

  listCollections(): Collection[] {
    return this.all("SELECT * FROM collections ORDER BY key").map(toCollection);
  }

  // --- cycles ---

  insertCycle(c: Cycle): void {
    this.run(
      "INSERT INTO cycles (id, collection_id, name, starts_on, ends_on, state) VALUES (?, ?, ?, ?, ?, ?)",
      c.id,
      c.collectionId,
      c.name,
      c.startsOn,
      c.endsOn,
      c.state,
    );
  }

  saveCycle(c: Cycle): void {
    this.run(
      "UPDATE cycles SET name = ?, starts_on = ?, ends_on = ?, state = ? WHERE id = ?",
      c.name,
      c.startsOn,
      c.endsOn,
      c.state,
      c.id,
    );
  }

  findCycle(collectionId: string, idOrName: string): Cycle | null {
    const row =
      this.one("SELECT * FROM cycles WHERE collection_id = ? AND id = ?", collectionId, idOrName) ??
      this.one(
        "SELECT * FROM cycles WHERE collection_id = ? AND name = ? COLLATE NOCASE",
        collectionId,
        idOrName,
      );
    return row ? toCycle(row) : null;
  }

  listCycles(collectionId: string): Cycle[] {
    return this.all(
      "SELECT * FROM cycles WHERE collection_id = ? ORDER BY starts_on, id",
      collectionId,
    ).map(toCycle);
  }

  // --- items ---

  nextItemNumber(collectionId: string): number {
    const row = this.one(
      "UPDATE collections SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS n",
      collectionId,
    );
    if (!row) throw new Error(`Unknown collection ${collectionId}`);
    return Number(row.n);
  }

  lastRank(collectionId: string): string | null {
    return optStr(
      this.one("SELECT max(rank) AS r FROM items WHERE collection_id = ?", collectionId)?.r,
    );
  }

  adjacentRank(
    collectionId: string,
    rank: string,
    side: "above" | "below",
    exceptId: string,
  ): string | null {
    const sql =
      side === "above"
        ? "SELECT max(rank) AS r FROM items WHERE collection_id = ? AND rank < ? AND id != ?"
        : "SELECT min(rank) AS r FROM items WHERE collection_id = ? AND rank > ? AND id != ?";
    return optStr(this.one(sql, collectionId, rank, exceptId)?.r);
  }

  insertItem(i: Item): void {
    this.run(
      `INSERT INTO items (id, collection_id, number, key, type, title, body, status, category,
        priority, assignee_id, parent_id, cycle_id, estimate, rank, due_at, created_at, updated_at,
        version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      i.id,
      i.collectionId,
      i.number,
      i.key,
      i.type,
      i.title,
      i.body,
      i.status,
      i.category,
      i.priority,
      i.assigneeId,
      i.parentId,
      i.cycleId,
      i.estimate,
      i.rank,
      i.dueAt,
      i.createdAt,
      i.updatedAt,
      i.version,
    );
    this.run(
      "INSERT INTO items_fts (item_id, title, body) VALUES (?, ?, ?)",
      i.id,
      i.title,
      i.body,
    );
  }

  getItem(id: string): Item | null {
    const row = this.one("SELECT * FROM items WHERE id = ?", id);
    return row ? toItem(row) : null;
  }

  getItemByKey(key: string): Item | null {
    const row = this.one("SELECT * FROM items WHERE key = ?", key);
    return row ? toItem(row) : null;
  }

  saveItem(i: Item, expectedVersion: number): boolean {
    const changed = this.run(
      `UPDATE items SET type = ?, title = ?, body = ?, status = ?, category = ?, priority = ?,
        assignee_id = ?, parent_id = ?, cycle_id = ?, estimate = ?, rank = ?, due_at = ?,
        updated_at = ?, version = ? WHERE id = ? AND version = ?`,
      i.type,
      i.title,
      i.body,
      i.status,
      i.category,
      i.priority,
      i.assigneeId,
      i.parentId,
      i.cycleId,
      i.estimate,
      i.rank,
      i.dueAt,
      i.updatedAt,
      i.version,
      i.id,
      expectedVersion,
    );
    if (changed !== 1) return false;
    this.run("DELETE FROM items_fts WHERE item_id = ?", i.id);
    this.run(
      "INSERT INTO items_fts (item_id, title, body) VALUES (?, ?, ?)",
      i.id,
      i.title,
      i.body,
    );
    return true;
  }

  listChildren(parentId: string): Item[] {
    return this.all("SELECT * FROM items WHERE parent_id = ? ORDER BY rank", parentId).map(toItem);
  }

  listItemsInCycle(cycleId: string): Item[] {
    return this.all("SELECT * FROM items WHERE cycle_id = ? ORDER BY rank", cycleId).map(toItem);
  }

  searchItems(request: SearchRequest): SearchResult {
    const sql = toSql(request.query, { me: request.me, now: request.now });
    const total = Number(
      this.one(`SELECT count(*) AS n FROM items i WHERE ${sql.where}`, ...sql.params)?.n ?? 0,
    );
    const items = this.all(
      `SELECT i.* FROM items i WHERE ${sql.where} ORDER BY ${sql.orderBy} LIMIT ? OFFSET ?`,
      ...sql.params,
      request.limit,
      request.offset,
    ).map(toItem);
    return { items, total };
  }

  // --- comments and links ---

  insertComment(c: Comment): void {
    this.run(
      "INSERT INTO comments (id, item_id, author_id, via_agent_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      c.id,
      c.itemId,
      c.authorId,
      c.viaAgentId,
      c.body,
      c.createdAt,
    );
  }

  listComments(itemId: string): Comment[] {
    return this.all("SELECT * FROM comments WHERE item_id = ? ORDER BY created_at, id", itemId).map(
      toComment,
    );
  }

  insertLink(l: Link): void {
    this.run(
      "INSERT INTO links (id, from_item_id, kind, target, created_at) VALUES (?, ?, ?, ?, ?)",
      l.id,
      l.fromItemId,
      l.kind,
      l.target,
      l.createdAt,
    );
  }

  listLinks(itemId: string): Link[] {
    return this.all(
      "SELECT * FROM links WHERE from_item_id = ? ORDER BY created_at, id",
      itemId,
    ).map(toLink);
  }

  listIncomingLinks(itemId: string): Link[] {
    return this.all("SELECT * FROM links WHERE target = ? ORDER BY created_at, id", itemId).map(
      toLink,
    );
  }

  // --- events and idempotency ---

  appendEvent(e: ShoalEvent): void {
    this.run(
      `INSERT INTO events (id, request_id, actor_id, via_agent_id, action, target_id, before, after, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.id,
      e.requestId,
      e.actorId,
      e.viaAgentId,
      e.action,
      e.targetId,
      JSON.stringify(e.before ?? null),
      JSON.stringify(e.after ?? null),
      e.at,
    );
  }

  listEvents(targetId: string): ShoalEvent[] {
    return this.all("SELECT * FROM events WHERE target_id = ? ORDER BY seq", targetId).map(toEvent);
  }

  getIdempotent(key: string): string | null {
    return optStr(this.one("SELECT result FROM idempotency WHERE key = ?", key)?.result);
  }

  putIdempotent(key: string, result: string): void {
    this.run("INSERT INTO idempotency (key, result) VALUES (?, ?)", key, result);
  }
}
