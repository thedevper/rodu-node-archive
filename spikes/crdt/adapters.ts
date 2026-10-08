// One small interface over each CRDT library, shaped like Rodu's replicated store would use it:
// a map of items (each a map of fields, with a collaborative-text body), synchronous reads and
// writes on an in-process replica, and byte blobs to move between replicas over any transport.

import * as A from "@automerge/automerge";
import { LoroDoc, LoroMap, LoroText } from "loro-crdt";
import * as Y from "yjs";

export type Field = "title" | "status" | "assigneeId" | "rank" | "number";
export type Value = string | number | null;

export interface Item {
  id: string;
  title: string;
  status: string;
  assigneeId: string | null;
  rank: string;
  number: number;
  body: string;
}

export interface Replica {
  create(item: Item): void;
  set(id: string, field: Field, value: Value): void;
  /** Inserts text into the body at a character offset. */
  insertBody(id: string, at: number, text: string): void;
  remove(id: string): void;
  get(id: string): Item | null;
  all(): Item[];
  /** Whole document, for a new peer or a cold start. */
  snapshot(): Uint8Array;
  /** Opaque marker of what this replica has seen, for incremental exports. */
  version(): unknown;
  /** Changes since `version`, for the transport. */
  updatesSince(version: unknown): Uint8Array;
  apply(bytes: Uint8Array): void;
}

export interface Library {
  name: string;
  replica(peer: number): Replica;
  load(peer: number, snapshot: Uint8Array): Replica;
}

const FIELDS = ["title", "status", "assigneeId", "rank", "number"] as const;

// --- Yjs: items is a Y.Map of Y.Maps; body is a Y.Text. -------------------------------------

function yReplica(doc: Y.Doc): Replica {
  const items = doc.getMap<Y.Map<unknown>>("items");
  const read = (id: string, m: Y.Map<unknown>): Item => ({
    id,
    title: m.get("title") as string,
    status: m.get("status") as string,
    assigneeId: (m.get("assigneeId") as string | null) ?? null,
    rank: m.get("rank") as string,
    number: m.get("number") as number,
    body: (m.get("body") as Y.Text).toString(),
  });
  return {
    create(item) {
      doc.transact(() => {
        const m = new Y.Map<unknown>();
        items.set(item.id, m);
        for (const f of FIELDS) m.set(f, item[f]);
        const body = new Y.Text();
        body.insert(0, item.body);
        m.set("body", body);
      });
    },
    set(id, field, value) {
      items.get(id)?.set(field, value);
    },
    insertBody(id, at, text) {
      (items.get(id)?.get("body") as Y.Text | undefined)?.insert(at, text);
    },
    remove(id) {
      items.delete(id);
    },
    get(id) {
      const m = items.get(id);
      return m ? read(id, m) : null;
    },
    all() {
      return [...items.entries()].map(([id, m]) => read(id, m));
    },
    snapshot: () => Y.encodeStateAsUpdate(doc),
    version: () => Y.encodeStateVector(doc),
    updatesSince: (v) => Y.encodeStateAsUpdate(doc, v as Uint8Array),
    apply: (bytes) => Y.applyUpdate(doc, bytes),
  };
}

export const yjs: Library = {
  name: "Yjs 13.6.33",
  replica(peer) {
    const doc = new Y.Doc();
    doc.clientID = peer;
    return yReplica(doc);
  },
  load(peer, snapshot) {
    const doc = new Y.Doc();
    doc.clientID = peer;
    Y.applyUpdate(doc, snapshot);
    return yReplica(doc);
  },
};

// --- Loro: items is a LoroMap of LoroMaps; body is a LoroText. -------------------------------

function loroReplica(doc: LoroDoc): Replica {
  const items = doc.getMap("items");
  const itemMap = (id: string) => {
    const m = items.get(id);
    return m instanceof LoroMap ? m : null;
  };
  const read = (id: string, m: LoroMap): Item => ({
    id,
    title: m.get("title") as string,
    status: m.get("status") as string,
    assigneeId: (m.get("assigneeId") as string | null) ?? null,
    rank: m.get("rank") as string,
    number: m.get("number") as number,
    body: (m.get("body") as LoroText).toString(),
  });
  return {
    create(item) {
      const m = items.setContainer(item.id, new LoroMap());
      for (const f of FIELDS) m.set(f, item[f]);
      m.setContainer("body", new LoroText()).insert(0, item.body);
      doc.commit();
    },
    set(id, field, value) {
      itemMap(id)?.set(field, value);
      doc.commit();
    },
    insertBody(id, at, text) {
      (itemMap(id)?.get("body") as LoroText | undefined)?.insert(at, text);
      doc.commit();
    },
    remove(id) {
      items.delete(id);
      doc.commit();
    },
    get(id) {
      const m = itemMap(id);
      return m ? read(id, m) : null;
    },
    all() {
      return items.keys().flatMap((id) => {
        const m = itemMap(id);
        return m ? [read(id, m)] : [];
      });
    },
    snapshot: () => doc.export({ mode: "snapshot" }),
    version: () => doc.oplogVersion(),
    updatesSince: (v) =>
      doc.export({ mode: "update", from: v as ReturnType<LoroDoc["oplogVersion"]> }),
    apply: (bytes) => {
      doc.import(bytes);
    },
  };
}

export const loro: Library = {
  name: "Loro 1.16.4",
  replica(peer) {
    const doc = new LoroDoc();
    doc.setPeerId(BigInt(peer));
    return loroReplica(doc);
  },
  load(peer, snapshot) {
    const doc = LoroDoc.fromSnapshot(snapshot);
    doc.setPeerId(BigInt(peer));
    return loroReplica(doc);
  },
};

// --- Automerge: a plain object tree; strings are collaborative text, edited with splice. ------

type AmItem = Omit<Item, "id">;
type AmDoc = { items: Record<string, AmItem> };

const actor = (peer: number) => peer.toString(16).padStart(32, "0") as A.ActorId;

// The shared genesis document. Without it, each peer's own `items` map would conflict.
const GENESIS = A.save(
  A.change(A.init<AmDoc>({ actor: actor(0xffff) }), (d) => {
    d.items = {};
  }),
);

function amReplica(start: A.Doc<AmDoc>): Replica {
  let doc = start;
  const read = (id: string, m: AmItem): Item => ({ id, ...m, body: String(m.body) });
  return {
    create(item) {
      const { id, ...rest } = item;
      doc = A.change(doc, (d) => {
        d.items[id] = rest;
      });
    },
    set(id, field, value) {
      doc = A.change(doc, (d) => {
        const m = d.items[id];
        if (m) (m as unknown as Record<string, Value>)[field] = value;
      });
    },
    insertBody(id, at, text) {
      doc = A.change(doc, (d) => {
        if (d.items[id]) A.splice(d, ["items", id, "body"], at, 0, text);
      });
    },
    remove(id) {
      doc = A.change(doc, (d) => {
        delete d.items[id];
      });
    },
    get(id) {
      const m = doc.items[id];
      return m ? read(id, m) : null;
    },
    all: () => Object.entries(doc.items).map(([id, m]) => read(id, m)),
    snapshot: () => A.save(doc),
    version: () => A.getHeads(doc),
    updatesSince: (v) => A.saveSince(doc, v as A.Heads),
    apply: (bytes) => {
      doc = A.loadIncremental(doc, bytes);
    },
  };
}

export const automerge: Library = {
  name: "Automerge 3.5.0",
  replica(peer) {
    // Every replica starts from the same root, as peers of one workspace would.
    return amReplica(A.load<AmDoc>(GENESIS, { actor: actor(peer) }));
  },
  load(peer, snapshot) {
    return amReplica(A.load<AmDoc>(snapshot, { actor: actor(peer) }));
  },
};

export const LIBRARIES = [yjs, loro, automerge];
