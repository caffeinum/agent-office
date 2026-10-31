// STUB (W1) — owner W3. Build public/city/sf/companies.json from scripts/city/sf/companies.src.json (spec §4 rules; fail loudly).
// Final exported signatures; bodies are TODO. Spec: docs/city/spec.md.
import { pathToFileURL } from "node:url";

/** Apply rules 1-8, geocode via EAS, place on the bldg grid, validateCompanies, write. → Promise<Companies> */
export async function buildCompanies({ srcPath = "scripts/city/sf/companies.src.json", manifestPath = "public/city/sf/manifest.json", outPath = "public/city/sf/companies.json" } = {}) {
  throw new Error("not implemented: buildCompanies");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await buildCompanies();
