import { LoroDoc } from "loro-crdt";

const d = new LoroDoc();
d.getMap("m").set("k", "v");
d.commit();
const b = d.export({ mode: "snapshot" });
const e = LoroDoc.fromSnapshot(b);
console.log("loro ok", e.getMap("m").get("k"), b.byteLength);
