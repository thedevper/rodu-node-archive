import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64";
import * as A from "@automerge/automerge/slim";

await A.initializeBase64Wasm(automergeWasmBase64);
const d = A.change(A.init(), (x) => {
  x.k = "v";
});
const b = A.save(d);
console.log("automerge base64 ok", A.load(b).k, b.byteLength);
