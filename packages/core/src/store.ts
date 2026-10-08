import type { Collection, Comment, Cycle, Item, Link, Principal, ShoalEvent } from "./model.ts";

export interface SearchRequest {
  /** JQL-lite query; empty matches everything. */
  query: string;
  /** Principal id that me() resolves to. */
  me: string | null;
  /** Clock that relative dates such as -7d are measured from. */
  now: Date;
  limit: number;
  offset: number;
}

export interface SearchResult {
  items: Item[];
  total: number;
}

/**
 * Persistence boundary of the domain. v0 ships a local SQLite store; the replicated
 * (CRDT) store chosen by the sync spike implements this same interface.
 * Methods are synchronous: every implementation keeps a local replica in-process.
 */
export interface Store {
  /** `"read"` takes a snapshot without the write lock; omit it for anything that writes. */
  transaction<T>(fn: () => T, mode?: "read"): T;

  insertPrincipal(principal: Principal): void;
  /** Looks up by id, then by name (case-insensitive). */
  findPrincipal(idOrName: string): Principal | null;
  listPrincipals(): Principal[];

  insertCollection(collection: Collection): void;
  /** Looks up by id, then by key (case-insensitive). */
  findCollection(idOrKey: string): Collection | null;
  listCollections(): Collection[];

  insertCycle(cycle: Cycle): void;
  saveCycle(cycle: Cycle): void;
  findCycle(collectionId: string, idOrName: string): Cycle | null;
  listCycles(collectionId: string): Cycle[];

  /** Allocates the next per-collection item number. */
  nextItemNumber(collectionId: string): number;
  /** Highest rank in the collection, to append new items at the end. */
  lastRank(collectionId: string): string | null;
  /** Nearest rank strictly above or below `rank` in the collection, ignoring item `exceptId`. */
  adjacentRank(
    collectionId: string,
    rank: string,
    side: "above" | "below",
    exceptId: string,
  ): string | null;
  insertItem(item: Item): void;
  getItem(id: string): Item | null;
  getItemByKey(key: string): Item | null;
  /** Writes `item` only if the stored version equals `expectedVersion`; returns false otherwise. */
  saveItem(item: Item, expectedVersion: number): boolean;
  listChildren(parentId: string): Item[];
  listItemsInCycle(cycleId: string): Item[];
  searchItems(request: SearchRequest): SearchResult;

  insertComment(comment: Comment): void;
  listComments(itemId: string): Comment[];

  insertLink(link: Link): void;
  listLinks(itemId: string): Link[];
  /** Links whose target is this item (e.g. items that block it). */
  listIncomingLinks(itemId: string): Link[];

  appendEvent(event: ShoalEvent): void;
  listEvents(targetId: string): ShoalEvent[];

  getIdempotent(key: string): string | null;
  putIdempotent(key: string, result: string): void;
}
