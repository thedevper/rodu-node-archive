import { LoroDoc, LoroMap, LoroText } from "loro-crdt";

const d = new LoroDoc();
const items = d.getMap("items");
for (let n = 0; n < 20000; n++) {
  const m = items.setContainer(`i${n}`, new LoroMap());
  m.set("title", `Card ${n}`);
  m.set("status", "Backlog");
  m.set("rank", `a${n}`);
  m.setContainer("body", new LoroText()).insert(0, "Body ".repeat(4));
}
d.commit();
const snap = d.export({ mode: "snapshot" });
let t = performance.now();
const e = LoroDoc.fromSnapshot(snap);
const load = performance.now() - t;
t = performance.now();
const json = e.getMap("items").toJSON();
const tj = performance.now() - t;
t = performance.now();
const one = (e.getMap("items").get("i12345") as LoroMap).get("title");
const tone = performance.now() - t;
console.log(
  `load ${load.toFixed(0)} ms, toJSON all ${tj.toFixed(0)} ms (${Object.keys(json).length}), one field ${tone.toFixed(2)} ms -> ${one}`,
);
