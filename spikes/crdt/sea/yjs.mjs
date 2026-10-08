import * as Y from "yjs";

const d = new Y.Doc();
d.getMap("m").set("k", "v");
const b = Y.encodeStateAsUpdate(d);
const e = new Y.Doc();
Y.applyUpdate(e, b);
console.log("yjs ok", e.getMap("m").get("k"), b.byteLength);
