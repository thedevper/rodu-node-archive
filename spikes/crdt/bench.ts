// Runs the same concurrency scenarios and size/speed measurements against each library.
//
//   node bench.ts [items]      (default 5000 items for the size/speed part)

import { LIBRARIES, type Library, type Replica } from "./adapters.ts";

const N = Number(process.argv[2] ?? 5000);

const card = (n: number, peer = 1) => ({
  id: `item-${peer}-${n}`,
  title: `Card ${n}`,
  status: "Backlog",
  assigneeId: null,
  rank: `a${n.toString(36).padStart(4, "0")}`,
  number: n,
  body: `Body of card ${n}. `.repeat(4),
});

/** Two-way exchange of everything each side has not seen. */
function sync(a: Replica, b: Replica): void {
  const va = a.version();
  const vb = b.version();
  const toB = a.updatesSince(vb);
  const toA = b.updatesSince(va);
  b.apply(toB);
  a.apply(toA);
}

function same(a: Replica, b: Replica): boolean {
  const key = (r: Replica) => JSON.stringify(r.all().sort((x, y) => x.id.localeCompare(y.id)));
  return key(a) === key(b);
}

interface Outcome {
  converged: boolean;
  note: string;
}

const SCENARIOS: Record<string, (lib: Library) => Outcome> = {
  "different fields edited concurrently": (lib) => {
    const a = lib.replica(1);
    const b = lib.replica(2);
    a.create(card(1));
    sync(a, b);
    a.set("item-1-1", "status", "In Progress");
    b.set("item-1-1", "assigneeId", "bob");
    sync(a, b);
    const it = a.get("item-1-1");
    return {
      converged: same(a, b),
      note: `status=${it?.status} assignee=${it?.assigneeId} (both kept: ${it?.status === "In Progress" && it?.assigneeId === "bob"})`,
    };
  },
  "same field edited concurrently": (lib) => {
    const a = lib.replica(1);
    const b = lib.replica(2);
    a.create(card(1));
    sync(a, b);
    a.set("item-1-1", "status", "Review");
    b.set("item-1-1", "status", "Done");
    sync(a, b);
    return { converged: same(a, b), note: `winner status=${a.get("item-1-1")?.status}` };
  },
  "body text edited concurrently": (lib) => {
    const a = lib.replica(1);
    const b = lib.replica(2);
    a.create({ ...card(1), body: "Steps:\n" });
    sync(a, b);
    a.insertBody("item-1-1", 7, "1. open app\n");
    b.insertBody("item-1-1", 7, "2. tap login\n");
    sync(a, b);
    const body = a.get("item-1-1")?.body ?? "";
    return {
      converged: same(a, b),
      note: `both lines kept: ${body.includes("open app") && body.includes("tap login")}`,
    };
  },
  "cards created concurrently get the same number": (lib) => {
    const a = lib.replica(1);
    const b = lib.replica(2);
    a.create(card(1, 1));
    sync(a, b);
    // Each side allocates "next number" from what it has seen: both pick 2.
    a.create(card(2, 1));
    b.create(card(2, 2));
    sync(a, b);
    const numbers = a.all().map((i) => i.number);
    return {
      converged: same(a, b),
      note: `${a.all().length} cards, numbers ${numbers.sort().join(",")} (duplicate keys: ${new Set(numbers).size !== numbers.length})`,
    };
  },
  "card moved to the same spot concurrently": (lib) => {
    const a = lib.replica(1);
    const b = lib.replica(2);
    a.create(card(1));
    a.create(card(2));
    a.create(card(3));
    sync(a, b);
    a.set("item-1-1", "rank", "a0001V");
    b.set("item-1-3", "rank", "a0001V");
    sync(a, b);
    const order = a
      .all()
      .sort((x, y) => x.rank.localeCompare(y.rank) || x.id.localeCompare(y.id))
      .map((i) => i.number);
    return { converged: same(a, b), note: `order by (rank, id): ${order.join(",")}` };
  },
  "edit vs delete": (lib) => {
    const a = lib.replica(1);
    const b = lib.replica(2);
    a.create(card(1));
    sync(a, b);
    a.remove("item-1-1");
    b.set("item-1-1", "title", "Edited while deleted");
    sync(a, b);
    return {
      converged: same(a, b),
      note: `card after merge: ${a.get("item-1-1") ? "kept" : "gone"}`,
    };
  },
  "three peers through a shared folder": (lib) => {
    // Each peer only ever reads the others' update files, as with Git, S3 or a synced folder.
    const peers = [lib.replica(1), lib.replica(2), lib.replica(3)];
    const folder: Uint8Array[] = [];
    const seen = peers.map(() => 0);
    const marks = peers.map((p) => p.version());
    const publish = (i: number) => {
      const p = peers[i] as Replica;
      folder.push(p.updatesSince(marks[i]));
      marks[i] = p.version();
    };
    const pull = (i: number) => {
      const p = peers[i] as Replica;
      for (; (seen[i] as number) < folder.length; seen[i] = (seen[i] as number) + 1) {
        p.apply(folder[seen[i] as number] as Uint8Array);
      }
      marks[i] = p.version();
    };
    (peers[0] as Replica).create(card(1, 1));
    publish(0);
    pull(1);
    pull(2);
    (peers[1] as Replica).set("item-1-1", "status", "In Progress");
    (peers[2] as Replica).insertBody("item-1-1", 0, "Note. ");
    publish(1);
    publish(2);
    for (const i of [0, 1, 2]) pull(i);
    const [p0, p1, p2] = peers as [Replica, Replica, Replica];
    const it = p0.get("item-1-1");
    return {
      converged: same(p0, p1) && same(p1, p2),
      note: `status=${it?.status}, body starts "${it?.body.slice(0, 6)}", ${folder.length} files`,
    };
  },
};

function time<T>(fn: () => T): [T, number] {
  const start = performance.now();
  const result = fn();
  return [result, performance.now() - start];
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const ms = (n: number) => `${n.toFixed(0)} ms`;

const only = process.env.LIBS?.split(",");
for (const lib of LIBRARIES.filter(
  (l) => !only || only.some((o) => l.name.toLowerCase().startsWith(o)),
)) {
  console.log(`\n## ${lib.name}`);
  for (const [name, run] of Object.entries(SCENARIOS)) {
    try {
      const { converged, note } = run(lib);
      console.log(`- ${converged ? "converged" : "DIVERGED "} | ${name}: ${note}`);
    } catch (error) {
      console.log(`- ERROR     | ${name}: ${(error as Error).message}`);
    }
  }

  const a = lib.replica(1);
  const [, create] = time(() => {
    for (let n = 1; n <= N; n++) a.create(card(n));
  });
  const before = a.version();
  const [, edit] = time(() => {
    for (let n = 1; n <= 100; n++) a.set(`item-1-${n}`, "status", "In Progress");
  });
  const oneEditMark = a.version();
  a.set("item-1-7", "title", "Renamed");
  const oneEdit = a.updatesSince(oneEditMark).byteLength;
  const hundredEdits = a.updatesSince(before).byteLength;
  const [snap, save] = time(() => a.snapshot());
  const [loaded, load] = time(() => lib.load(9, snap));
  const [all, readAll] = time(() => loaded.all());
  globalThis.gc?.();
  const heap = process.memoryUsage();
  console.log(
    `- ${N} cards: create ${ms(create)}, 100 status edits ${ms(edit)}, snapshot ${kb(snap.byteLength)} ` +
      `(save ${ms(save)}, cold load ${ms(load)}, read all ${ms(readAll)}; ${all.length} cards), ` +
      `one edit ${oneEdit} B, 100 edits ${kb(hundredEdits)}, ` +
      `rss ${(heap.rss / 1048576).toFixed(0)} MB (heap ${(heap.heapUsed / 1048576).toFixed(0)} MB)`,
  );
}
