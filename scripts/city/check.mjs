// `npm run check:city`: runs every scripts/city/checks/*.check.mjs in its own node process, in name order.
// Deterministic checks only (no timing gates). Exits non-zero if any check file fails.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "checks");
const files = readdirSync(dir).filter((f) => f.endsWith(".check.mjs")).sort();
if (files.length === 0) throw new Error(`check:city: no *.check.mjs files in ${dir}`);

const failed = [];
for (const f of files) {
  console.log(`── ${f}`);
  const r = spawnSync(process.execPath, [join(dir, f)], { stdio: "inherit" });
  if (r.status !== 0) failed.push(`${f} (exit ${r.status ?? r.signal})`);
}
if (failed.length) {
  console.error(`check:city: ${failed.length} of ${files.length} failed: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`check:city: ${files.length} check files passed`);
