import { createHash } from "node:crypto";
import { z } from "zod";
import { RoduError } from "./errors.ts";
import { type ContextParts, formatContext } from "./format.ts";
import { formatKey, isUuid, uuidv7 } from "./ids.ts";
import {
  type Actor,
  type Category,
  COLLECTION_KEY,
  type Collection,
  type Comment,
  type Cycle,
  IsoDateSchema,
  type Item,
  ItemPatchSchema,
  LINK_KINDS,
  type Link,
  NewItemSchema,
  type Principal,
  SINGLE_LINE,
} from "./model.ts";
import { DEV_WORKFLOW } from "./presets.ts";
import { rankBetween } from "./rank.ts";
import type { SearchResult, Store } from "./store.ts";
import { checkTransition, findState, validateWorkflow } from "./workflow.ts";

export interface ServiceOptions {
  now?: () => Date;
  /** Most items one create_items call may create; larger plans should be split or reviewed. */
  maxBatch?: number;
}

export interface CycleReport {
  cycle: Cycle;
  total: number;
  byCategory: Record<Category, number>;
  points: { total: number; done: number };
  remaining: Item[];
  blocked: Item[];
}

const PRINCIPAL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const DEFAULT_CONTEXT_TOKENS = 4000;

function checkName(name: string, max: number): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > max || !SINGLE_LINE.test(trimmed)) {
    throw new RoduError("invalid", `Name must be one line of 1-${max} characters`);
  }
  return trimmed;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((i) => `${i.path.join(".") || what}: ${i.message}`)
    .join("; ");
  throw new RoduError("invalid", `Invalid ${what}: ${issues}`);
}

/**
 * The single command layer. The CLI, the MCP server and (later) the UI call these methods,
 * so every surface shares the same validation, workflow rules and audit events.
 */
export class RoduService {
  readonly store: Store;
  readonly maxBatch: number;
  private readonly now: () => Date;

  constructor(store: Store, options: ServiceOptions = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
    this.maxBatch = options.maxBatch ?? 25;
  }

  // --- principals -------------------------------------------------------------------------

  createPrincipal(input: { name: string; kind: "human" | "agent"; ownerId?: string }): Principal {
    if (!PRINCIPAL_NAME.test(input.name)) {
      throw new RoduError(
        "invalid",
        `Invalid name "${input.name}"`,
        "Use 1-40 letters, digits, dots, dashes or underscores",
      );
    }
    if (this.store.findPrincipal(input.name)) {
      throw new RoduError("conflict", `Principal "${input.name}" already exists`);
    }
    if (input.kind === "agent" && !input.ownerId) {
      throw new RoduError("invalid", "An agent needs a human owner");
    }
    if (input.ownerId && this.principal(input.ownerId).kind !== "human") {
      throw new RoduError("invalid", "An agent's owner must be a human");
    }
    const principal: Principal = {
      id: uuidv7(this.now().getTime()),
      kind: input.kind,
      name: input.name,
      ownerId: input.kind === "agent" ? (input.ownerId ?? null) : null,
    };
    this.store.insertPrincipal(principal);
    return principal;
  }

  principal(ref: string): Principal {
    const found = this.store.findPrincipal(ref);
    if (!found) {
      const names = this.store.listPrincipals().map((p) => p.name);
      throw new RoduError("not_found", `No principal "${ref}"`, `Known: ${names.join(", ")}`);
    }
    return found;
  }

  private resolveAssignee(ref: string, actor: Actor): string {
    return ref.toLowerCase() === "me" ? actor.principalId : this.principal(ref).id;
  }

  // --- collections and cycles -------------------------------------------------------------

  createCollection(actor: Actor, input: { key: string; name: string }): Collection {
    const key = input.key.toUpperCase();
    if (!COLLECTION_KEY.test(key)) {
      throw new RoduError(
        "invalid",
        `Invalid collection key "${input.key}"`,
        "Use 2-10 letters or digits starting with a letter, e.g. DEMO",
      );
    }
    if (this.store.findCollection(key)) {
      throw new RoduError("conflict", `Collection ${key} already exists`);
    }
    const name = checkName(input.name, 80);
    validateWorkflow(DEV_WORKFLOW);
    const collection: Collection = {
      id: uuidv7(this.now().getTime()),
      key,
      name,
      preset: "dev",
      workflow: structuredClone(DEV_WORKFLOW),
      createdAt: this.now().toISOString(),
    };
    this.store.transaction(() => {
      this.store.insertCollection(collection);
      this.record(uuidv7(), actor, "collection.create", collection.id, null, collection);
    });
    return collection;
  }

  collection(ref: string): Collection {
    const found = this.store.findCollection(ref);
    if (!found) {
      const keys = this.store.listCollections().map((c) => c.key);
      throw new RoduError(
        "not_found",
        `No collection "${ref}"`,
        keys.length > 0 ? `Known collections: ${keys.join(", ")}` : "Create one first",
      );
    }
    return found;
  }

  listCollections(): Collection[] {
    return this.store.listCollections();
  }

  cycle(collection: Collection, ref: string): Cycle {
    const found = this.store.findCycle(collection.id, ref);
    if (!found) {
      const names = this.store.listCycles(collection.id).map((c) => c.name);
      throw new RoduError(
        "not_found",
        `No cycle "${ref}" in ${collection.key}`,
        names.length > 0 ? `Cycles: ${names.join(", ")}` : "Create a cycle first",
      );
    }
    return found;
  }

  createCycle(
    actor: Actor,
    collectionRef: string,
    input: { name: string; startsOn?: string; endsOn?: string },
  ): Cycle {
    const collection = this.collection(collectionRef);
    const name = checkName(input.name, 60);
    if (this.store.findCycle(collection.id, name)) {
      throw new RoduError("conflict", `Cycle "${name}" already exists in ${collection.key}`);
    }
    const startsOn = input.startsOn ? parseInput(IsoDateSchema, input.startsOn, "startsOn") : null;
    const endsOn = input.endsOn ? parseInput(IsoDateSchema, input.endsOn, "endsOn") : null;
    if (startsOn && endsOn && endsOn < startsOn) {
      throw new RoduError("invalid", "endsOn must not be before startsOn");
    }
    const cycle: Cycle = {
      id: uuidv7(this.now().getTime()),
      collectionId: collection.id,
      name,
      startsOn,
      endsOn,
      state: "planned",
    };
    this.store.transaction(() => {
      this.store.insertCycle(cycle);
      this.record(uuidv7(), actor, "cycle.create", cycle.id, null, cycle);
    });
    return cycle;
  }

  startCycle(actor: Actor, collectionRef: string, cycleRef: string): Cycle {
    const collection = this.collection(collectionRef);
    const cycle = this.cycle(collection, cycleRef);
    if (cycle.state !== "planned") {
      throw new RoduError("invalid", `Cycle "${cycle.name}" is ${cycle.state}, not planned`);
    }
    const active = this.store.listCycles(collection.id).find((c) => c.state === "active");
    if (active) {
      throw new RoduError(
        "conflict",
        `Cycle "${active.name}" is still active in ${collection.key}`,
        "Close it first",
      );
    }
    const started: Cycle = { ...cycle, state: "active" };
    this.store.transaction(() => {
      this.store.saveCycle(started);
      this.record(uuidv7(), actor, "cycle.start", cycle.id, cycle, started);
    });
    return started;
  }

  /** Closes a cycle; unfinished items move to `carryOverTo` (a planned cycle) or the backlog. */
  closeCycle(
    actor: Actor,
    collectionRef: string,
    cycleRef: string,
    carryOverTo?: string,
  ): { cycle: Cycle; carried: Item[] } {
    const collection = this.collection(collectionRef);
    const cycle = this.cycle(collection, cycleRef);
    if (cycle.state !== "active") {
      throw new RoduError("invalid", `Cycle "${cycle.name}" is ${cycle.state}, not active`);
    }
    const next = carryOverTo ? this.cycle(collection, carryOverTo) : null;
    if (next && next.state !== "planned") {
      throw new RoduError("invalid", `Cycle "${next.name}" is ${next.state}, not planned`);
    }
    const requestId = uuidv7();
    return this.store.transaction(() => {
      const carried: Item[] = [];
      for (const item of this.store.listItemsInCycle(cycle.id)) {
        if (item.category === "done") continue;
        carried.push(this.writeItem(requestId, actor, item, { cycleId: next?.id ?? null }));
      }
      const closed: Cycle = { ...cycle, state: "closed" };
      this.store.saveCycle(closed);
      this.record(requestId, actor, "cycle.close", cycle.id, cycle, closed);
      return { cycle: closed, carried };
    });
  }

  cycleReport(collectionRef: string, cycleRef?: string): CycleReport {
    const collection = this.collection(collectionRef);
    const cycle = cycleRef
      ? this.cycle(collection, cycleRef)
      : this.store.listCycles(collection.id).find((c) => c.state === "active");
    if (!cycle) {
      throw new RoduError("not_found", `${collection.key} has no active cycle`, "Name a cycle");
    }
    const items = this.store.listItemsInCycle(cycle.id);
    const byCategory: Record<Category, number> = { backlog: 0, active: 0, review: 0, done: 0 };
    let total = 0;
    let done = 0;
    for (const item of items) {
      byCategory[item.category] += 1;
      total += item.estimate ?? 0;
      if (item.category === "done") done += item.estimate ?? 0;
    }
    const remaining = items.filter((i) => i.category !== "done");
    const blocked = remaining.filter((item) =>
      this.store.listIncomingLinks(item.id).some((l) => {
        if (l.kind !== "blocks") return false;
        const blocker = this.store.getItem(l.fromItemId);
        return blocker !== null && blocker.category !== "done";
      }),
    );
    return { cycle, total: items.length, byCategory, points: { total, done }, remaining, blocked };
  }

  // --- items ------------------------------------------------------------------------------

  item(ref: string): Item {
    const found = isUuid(ref)
      ? this.store.getItem(ref)
      : this.store.getItemByKey(ref.trim().toUpperCase());
    if (!found) throw new RoduError("not_found", `No item "${ref}"`, "Use a key such as DEMO-12");
    return found;
  }

  createItems(
    actor: Actor,
    collectionRef: string,
    inputs: unknown[],
    idempotencyKey?: string,
  ): Item[] {
    if (inputs.length === 0) throw new RoduError("invalid", "Nothing to create");
    if (inputs.length > this.maxBatch) {
      throw new RoduError(
        "limit",
        `Too many items in one call (${inputs.length} > ${this.maxBatch})`,
        "Split the plan into smaller batches so a person can review each one",
      );
    }
    const collection = this.collection(collectionRef);
    const parsed = inputs.map((input, i) => parseInput(NewItemSchema, input, `items[${i}]`));
    const initial = findState(collection.workflow, collection.workflow.initial);
    if (!initial) throw new RoduError("invalid", "Collection workflow has no initial state");
    const requestId = uuidv7();
    const scopedKey = idempotencyKey ? `${actor.principalId}:create_items:${idempotencyKey}` : null;
    // The key is bound to the request it first served, so reusing it for other input is an error.
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([collection.id, parsed]))
      .digest("hex");

    return this.store.transaction(() => {
      const previous = scopedKey ? this.store.getIdempotent(scopedKey) : null;
      if (previous) {
        const parsedPrevious = JSON.parse(previous) as
          | string[]
          | { fingerprint: string; ids: string[] };
        // Records written before fingerprints existed are a bare id list: replay them as before.
        const saved = Array.isArray(parsedPrevious)
          ? { fingerprint, ids: parsedPrevious }
          : parsedPrevious;
        if (saved.fingerprint !== fingerprint) {
          throw new RoduError(
            "conflict",
            `Idempotency key "${idempotencyKey}" was already used for a different request`,
            "Use a new idempotency_key for a new request",
          );
        }
        return saved.ids.map((id) => this.item(id));
      }
      const created: Item[] = [];
      let rank = this.store.lastRank(collection.id);
      for (const input of parsed) {
        const now = this.now().toISOString();
        const number = this.store.nextItemNumber(collection.id);
        rank = rankBetween(rank, null);
        const item: Item = {
          id: uuidv7(this.now().getTime()),
          collectionId: collection.id,
          number,
          key: formatKey(collection.key, number),
          type: input.type,
          title: input.title,
          body: input.body,
          status: initial.name,
          category: initial.category,
          priority: input.priority,
          assigneeId: input.assignee ? this.resolveAssignee(input.assignee, actor) : null,
          parentId: input.parent ? this.item(input.parent).id : null,
          cycleId: input.cycle ? this.openCycle(collection, input.cycle).id : null,
          estimate: input.estimate ?? null,
          rank,
          dueAt: input.dueAt ?? null,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        this.store.insertItem(item);
        this.record(requestId, actor, "item.create", item.id, null, item);
        created.push(item);
      }
      if (scopedKey) {
        const ids = created.map((i) => i.id);
        this.store.putIdempotent(scopedKey, JSON.stringify({ fingerprint, ids }));
      }
      return created;
    });
  }

  updateItem(actor: Actor, ref: string, patchInput: unknown, expectedVersion?: number): Item {
    const patch = parseInput(ItemPatchSchema, patchInput, "patch");
    const item = this.item(ref);
    if (expectedVersion !== undefined && expectedVersion !== item.version) {
      throw new RoduError(
        "conflict",
        `${item.key} changed (version ${item.version}, you sent ${expectedVersion})`,
        `Read ${item.key} again and retry with expected_version ${item.version}`,
      );
    }
    const collection = this.collection(item.collectionId);
    const changes: Partial<Item> = {};
    if (patch.title !== undefined) changes.title = patch.title;
    if (patch.type !== undefined) changes.type = patch.type;
    if (patch.body !== undefined) changes.body = patch.body;
    if (patch.priority !== undefined) changes.priority = patch.priority;
    if (patch.estimate !== undefined) changes.estimate = patch.estimate;
    if (patch.dueAt !== undefined) changes.dueAt = patch.dueAt;
    if (patch.assignee !== undefined) {
      changes.assigneeId =
        patch.assignee === null ? null : this.resolveAssignee(patch.assignee, actor);
    }
    if (patch.parent !== undefined) {
      changes.parentId = patch.parent === null ? null : this.checkedParent(item, patch.parent).id;
    }
    if (patch.cycle !== undefined) {
      changes.cycleId = patch.cycle === null ? null : this.openCycle(collection, patch.cycle).id;
    }
    if (Object.keys(changes).length === 0) throw new RoduError("invalid", "Nothing to update");
    return this.store.transaction(() => this.writeItem(uuidv7(), actor, item, changes));
  }

  /**
   * Reorders an item: `after` is the item that should sit just above it, `before` the one just
   * below. With only one given, the item goes right next to it.
   */
  moveItem(actor: Actor, ref: string, to: { after?: string | null; before?: string | null }): Item {
    // Read neighbours inside the transaction so another process cannot move them in between.
    return this.store.transaction(() => this.placeItem(actor, ref, to));
  }

  private placeItem(
    actor: Actor,
    ref: string,
    to: { after?: string | null; before?: string | null },
  ): Item {
    const item = this.item(ref);
    const neighbour = (r: string | null | undefined): Item | null => {
      if (!r) return null;
      const other = this.item(r);
      if (other.collectionId !== item.collectionId) {
        throw new RoduError("invalid", `${other.key} is not in the same collection as ${item.key}`);
      }
      if (other.id === item.id)
        throw new RoduError("invalid", "An item cannot move next to itself");
      return other;
    };
    const after = neighbour(to.after);
    const before = neighbour(to.before);
    if (!after && !before) throw new RoduError("invalid", "Say where to move: after or before");
    if (after && before && after.rank >= before.rank) {
      throw new RoduError(
        "conflict",
        `${after.key} is not above ${before.key} any more`,
        "Reload the list and try again",
      );
    }
    // With one side given, the other is whatever sits next to it now, so ranks never collide.
    const id = item.collectionId;
    const low =
      after?.rank ?? (before ? this.store.adjacentRank(id, before.rank, "above", item.id) : null);
    const high =
      before?.rank ?? (after ? this.store.adjacentRank(id, after.rank, "below", item.id) : null);
    // low < high holds here (checked above, or strict adjacency), so a throw means corrupt ranks.
    return this.writeItem(uuidv7(), actor, item, { rank: rankBetween(low, high) });
  }

  transition(actor: Actor, ref: string, to: string): Item {
    const item = this.item(ref);
    const collection = this.collection(item.collectionId);
    const target = checkTransition(collection.workflow, item, to, this.store.listLinks(item.id));
    return this.store.transaction(() =>
      this.writeItem(uuidv7(), actor, item, { status: target.name, category: target.category }),
    );
  }

  comment(actor: Actor, ref: string, body: string): Comment {
    const text = body.trim();
    if (!text || text.length > 20_000) {
      throw new RoduError("invalid", "Comment must be 1-20000 characters");
    }
    const item = this.item(ref);
    const comment: Comment = {
      id: uuidv7(this.now().getTime()),
      itemId: item.id,
      authorId: actor.principalId,
      viaAgentId: actor.viaAgentId,
      body: text,
      createdAt: this.now().toISOString(),
    };
    this.store.transaction(() => {
      this.store.insertComment(comment);
      this.record(uuidv7(), actor, "comment.create", item.id, null, comment);
    });
    return comment;
  }

  link(actor: Actor, ref: string, kind: string, target: string): Link {
    const linkKind = parseInput(z.enum(LINK_KINDS), kind, "kind");
    const item = this.item(ref);
    let targetValue: string;
    if (linkKind === "implements_pr") {
      targetValue = parseInput(z.url({ protocol: /^https?$/ }), target, "target");
    } else {
      const other = this.item(target);
      if (other.id === item.id) throw new RoduError("invalid", "An item cannot link to itself");
      if (linkKind === "blocks" && this.blocksTransitively(other.id, item.id)) {
        throw new RoduError(
          "invalid",
          `${item.key} cannot block ${other.key}: ${other.key} already blocks it, which would be a cycle`,
        );
      }
      targetValue = other.id;
    }
    if (
      this.store.listLinks(item.id).some((l) => l.kind === linkKind && l.target === targetValue)
    ) {
      throw new RoduError("conflict", `${item.key} already has this ${linkKind} link`);
    }
    const link: Link = {
      id: uuidv7(this.now().getTime()),
      fromItemId: item.id,
      kind: linkKind,
      target: targetValue,
      createdAt: this.now().toISOString(),
    };
    this.store.transaction(() => {
      this.store.insertLink(link);
      this.record(uuidv7(), actor, "link.create", item.id, null, link);
    });
    return link;
  }

  search(
    actor: Actor,
    query: string,
    options: { limit?: number; offset?: number } = {},
  ): SearchResult {
    const limit = Number.isInteger(options.limit)
      ? Math.min(Math.max(options.limit ?? 20, 1), 100)
      : 20;
    const offset = Number.isInteger(options.offset) ? Math.max(options.offset ?? 0, 0) : 0;
    return this.store.searchItems({ query, me: actor.principalId, now: this.now(), limit, offset });
  }

  myWork(actor: Actor): Item[] {
    return this.search(actor, "assignee = me() AND category != done ORDER BY priority", {
      limit: 100,
    }).items;
  }

  /** Markdown bundle of an item and what surrounds it, sized for an agent's context window. */
  context(ref: string, tokenBudget: number = DEFAULT_CONTEXT_TOKENS): string {
    const item = this.item(ref);
    const collection = this.collection(item.collectionId);
    const name = (id: string | null): string | null =>
      id ? (this.store.findPrincipal(id)?.name ?? id) : null;
    const parts: ContextParts = {
      item,
      collection,
      assignee: name(item.assigneeId),
      parent: item.parentId ? this.store.getItem(item.parentId) : null,
      children: this.store.listChildren(item.id),
      cycle: item.cycleId ? this.store.findCycle(collection.id, item.cycleId) : null,
      links: this.store.listLinks(item.id).map((link) => ({
        link,
        targetItem: link.kind === "implements_pr" ? null : this.store.getItem(link.target),
      })),
      incoming: this.store
        .listIncomingLinks(item.id)
        .map((link) => ({ link, fromItem: this.store.getItem(link.fromItemId) })),
      comments: this.store.listComments(item.id).map((comment) => ({
        comment,
        author: name(comment.authorId) ?? comment.authorId,
        via: name(comment.viaAgentId),
      })),
    };
    return formatContext(parts, Math.max(tokenBudget, 500) * 4);
  }

  // --- internals --------------------------------------------------------------------------

  private openCycle(collection: Collection, ref: string): Cycle {
    const cycle = this.cycle(collection, ref);
    if (cycle.state === "closed") {
      throw new RoduError("invalid", `Cycle "${cycle.name}" is closed`);
    }
    return cycle;
  }

  /** Whether `fromId` blocks `toId` through a chain of blocks links. */
  private blocksTransitively(fromId: string, toId: string): boolean {
    const seen = new Set<string>();
    const queue = [fromId];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (id === toId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const l of this.store.listLinks(id)) if (l.kind === "blocks") queue.push(l.target);
    }
    return false;
  }

  private checkedParent(item: Item, parentRef: string): Item {
    const parent = this.item(parentRef);
    for (let cursor: Item | null = parent; cursor; ) {
      if (cursor.id === item.id) {
        throw new RoduError(
          "invalid",
          `${parent.key} cannot be the parent of ${item.key}`,
          "That would create a loop",
        );
      }
      cursor = cursor.parentId ? this.store.getItem(cursor.parentId) : null;
    }
    return parent;
  }

  private writeItem(requestId: string, actor: Actor, item: Item, changes: Partial<Item>): Item {
    const next: Item = {
      ...item,
      ...changes,
      updatedAt: this.now().toISOString(),
      version: item.version + 1,
    };
    if (!this.store.saveItem(next, item.version)) {
      throw new RoduError(
        "conflict",
        `${item.key} was changed by someone else`,
        `Read ${item.key} again and retry`,
      );
    }
    this.record(requestId, actor, "item.update", item.id, item, next);
    return next;
  }

  private record(
    requestId: string,
    actor: Actor,
    action: string,
    targetId: string,
    before: unknown,
    after: unknown,
  ): void {
    this.store.appendEvent({
      id: uuidv7(this.now().getTime()),
      requestId,
      actorId: actor.principalId,
      viaAgentId: actor.viaAgentId,
      action,
      targetId,
      before,
      after,
      at: this.now().toISOString(),
    });
  }
}
