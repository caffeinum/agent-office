// `npm run city:walk`: writes public/city/sf/{walk.bin,places.json} (spec-v2 §7.6). W1 stub; W5 owns this file
// from the W1 merge. Fails loudly until W5 lands, so city:build cannot ship without a walk graph.
import { pathToFileURL } from "node:url";
import { buildWalk } from "./lib/walk.mjs";

export async function walkSf() {
  return buildWalk({});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await walkSf();
