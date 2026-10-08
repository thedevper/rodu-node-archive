import { LoroDoc } from "loro-crdt/base64";

const d = new LoroDoc();
d.getMap("m").set("k", "v");
d.commit();
const b = d.export({ mode: "snapshot" });
const e = LoroDoc.fromSnapshot(b);
console.log("loro base64 ok", e.getMap("m").get("k"), b.byteLength);
