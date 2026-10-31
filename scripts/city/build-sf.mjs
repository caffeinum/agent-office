// STUB (W1) — owner W2. Build public/city/sf/{manifest.json,chunks/*,LICENSE.txt} and data/city/sf/build/{report.json,topdown.png} from the raw cache.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.
import { pathToFileURL } from "node:url";

/** Run the full build from raw/ (never hits the network). → Promise<{manifest, report}> */
export async function buildSf() {
  throw new Error("not implemented: buildSf");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildSf();
