// STUB (W1) — owner W4. `npm run city:perf`: mesher timings (report only, not part of check).
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.
import { pathToFileURL } from "node:url";

/** Time meshChunk on chunk (56,26) (target ≤ 15 ms) and print the report. → Promise<void> */
export async function perf() {
  throw new Error("not implemented: perf");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await perf();
