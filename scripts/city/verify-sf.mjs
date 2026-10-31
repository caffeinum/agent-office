// STUB (W1) — owner W2. Known-point gates on the built city (spec §5 W2 acceptance). Fails the run on any miss.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.
import { pathToFileURL } from "node:url";

/** Decode the built city in `dir` and assert every known point + the water/land gate. → Promise<{passed: string[], skipped: string[]}> */
export async function verifySf(dir = "public/city/sf") {
  throw new Error("not implemented: verifySf");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifySf();
