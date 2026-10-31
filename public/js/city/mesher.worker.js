// STUB (W1) — owner W4. Stateless module worker around handleMeshRequest.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.
import { handleMeshRequest } from "./mesher.js";

self.onmessage = (e) => {
  try {
    const { reply, transfer } = handleMeshRequest(e.data);
    self.postMessage(reply, transfer);
  } catch (err) {
    self.postMessage({ id: e.data?.id, error: String(err?.stack || err) });
  }
};
