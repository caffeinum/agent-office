// Stateless module worker around handleMeshRequest. Spawn with `new Worker(url, {type: "module"})`.
// Request/reply shapes: see handleMeshRequest in mesher.js. Errors come back as {id, error}.
import { handleMeshRequest } from "./mesher.js";

self.onmessage = (e) => {
  try {
    const { reply, transfer } = handleMeshRequest(e.data);
    self.postMessage(reply, transfer);
  } catch (err) {
    self.postMessage({ id: e.data?.id, error: String(err?.stack || err) });
  }
};
