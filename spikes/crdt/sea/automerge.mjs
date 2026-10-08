import * as A from "@automerge/automerge";

const d = A.change(A.init(), (x) => {
  x.k = "v";
});
const b = A.save(d);
console.log("automerge ok", A.load(b).k, b.byteLength);
