// STUB (W1) — owner W2. Fetch raw sources into data/city/sf/raw/ (spec §2). `npm run city:fetch [-- --force]`.
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.
import { pathToFileURL } from "node:url";

/** Fetch every source once (cached; --force re-downloads, Overpass 24 h cooldown) and write raw/sources.json. → Promise<sources[]> */
export async function fetchSf({ force = false } = {}) {
  throw new Error("not implemented: fetchSf");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await fetchSf({ force: process.argv.includes("--force") });
