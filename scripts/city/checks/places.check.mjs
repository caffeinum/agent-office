// W5 checks (spec-v2 §7.6, §8 W5): places.src.json, the resolver (src/city/places.ts) on the fixture and on a
// small synthetic doc, and the spec's query list on the sf build once the v2 rebuild exists [post-int].
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CITY_VERSION, SF_BOX, decodeWalk, validateCompanies, validateManifest, validatePlaces } from "../../../public/shared/city.js";
import { PlaceError, canonical, resolvePlace } from "../../../src/city/places.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n${e.stack}`);
    process.exitCode = 1;
  }
}
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

/** Expect a PlaceError; → its candidates. */
function rejects(query, ctx, re) {
  try {
    resolvePlace(query, ctx);
  } catch (e) {
    assert.ok(e instanceof PlaceError, `${query}: ${e.message} is not a PlaceError`);
    assert.match(e.message, re, query);
    assert.ok(e.candidates.length <= 5, `${query}: ${e.candidates.length} candidates`);
    return e.candidates;
  }
  assert.fail(`"${query}" resolved, expected a PlaceError`);
}

// ---------- places.src.json ----------

await test("places.src.json lists the 14 spec places, each sourced and inside the city box", () => {
  const src = readJson("scripts/city/sf/places.src.json");
  const want = [
    "Ferry Building", "Coit Tower", "Oracle Park", "Salesforce Tower", "Transamerica", "Pier 39", "Palace of Fine Arts", "Crissy Field",
    "Fort Point", "Presidio Main Post", "Union Square", "Chase Center", "Moscone Center", "Ghirardelli Square",
  ];
  assert.deepEqual(src.map((p) => p.name).sort(), [...want].sort());
  assert.equal(new Set(src.map((p) => p.id)).size, src.length, "unique ids");
  for (const p of src) {
    assert.match(p.source.url, /^https:\/\//, p.id);
    assert.match(p.source.accessed, /^\d{4}-\d{2}-\d{2}$/, p.id);
    assert.ok(p.lon > SF_BOX.west && p.lon < SF_BOX.east && p.lat > SF_BOX.south && p.lat < SF_BOX.north, `${p.id} inside SF_BOX`);
  }
});

// ---------- canonical ----------

await test("canonical: case, punctuation, the, suffixes, ordinals", () => {
  assert.equal(canonical("  The Embarcadero "), "embarcadero");
  assert.equal(canonical("501 Second Street"), "501 2nd st");
  assert.equal(canonical("2nd St."), "2nd st");
  assert.equal(canonical("Howard&2nd"), "howard & 2nd");
  assert.equal(canonical("Fisherman’s Wharf"), "fishermans wharf");
  assert.equal(canonical("Café Avenue"), "cafe ave");
});

// ---------- fixture ----------

const fxManifest = validateManifest(readJson("public/city/fixture/manifest.json"));
const fxWalk = decodeWalk(new Uint8Array(readFileSync(join(ROOT, "public/city/fixture/walk.bin"))), fxManifest);
const fx = {
  places: validatePlaces(readJson("public/city/fixture/places.json"), fxManifest, fxWalk),
  sites: validateCompanies(readJson("public/city/fixture/companies.json"), fxManifest).sites,
};
const id = (q, ctx = fx) => resolvePlace(q, ctx).id;

await test("fixture: names, aliases, intersections and addresses resolve uniquely", () => {
  assert.equal(id("Fixture Labs"), "site:fixture-labs");
  assert.equal(id("fixture labs"), "site:fixture-labs");
  assert.equal(id("Example Robotics"), "site:example-robotics");
  assert.equal(id("Fixture Ferry"), "lm:fixture-ferry");
  assert.equal(id("the ferry"), "lm:fixture-ferry");
  assert.equal(id("Fixture Park"), "area:fixture-park");
  for (const q of ["Fixture Ave & Test St", "test st and fixture ave", "Test Street at Fixture Avenue", "fixture & test", "TEST ST & FIXTURE AVE"]) {
    assert.equal(id(q), "x:fixture-ave&test-st", q);
  }
  assert.equal(id("7 Slope Lane"), "site:sample-bakery");
  assert.equal(id("7 slope ln"), "site:sample-bakery", "suffix spelling");
  assert.equal(id("7 Slope"), "site:sample-bakery", "street-number address without suffix");
  assert.equal(id("bakery"), "site:sample-bakery", "unique word match");
});

await test("fixture: ambiguous and unknown queries throw PlaceError with candidates", () => {
  const two = rejects("1 Fixture Tower", fx, /ambiguous: 2 places match/);
  assert.deepEqual(two.map((p) => p.id).sort(), ["site:example-robotics", "site:fixture-labs"]);
  assert.ok(rejects("Fixture", fx, /ambiguous/).length >= 2);
  const unknown = rejects("Nowhere Plaza", fx, /unknown place "Nowhere Plaza"/);
  assert.ok(unknown.length > 0, "unknown queries still offer candidates");
  rejects("   ", fx, /empty place query/);
  rejects("!!!", fx, /no letters or digits/);
  rejects("Mars Ave & Venus St", fx, /unknown place/);
});

await test("several sites of one company resolve to its primary; two companies at one address stay ambiguous", () => {
  const base = fx.places.places.find((p) => p.id === "site:fixture-labs");
  const site = fx.sites.find((s) => s.id === "fixture-labs");
  const doc = {
    builtAt: fx.places.builtAt,
    places: [
      { ...base, id: "site:acme-a", siteId: "acme-a", name: "Acme", aliases: ["1 Main St"] },
      { ...base, id: "site:acme-b", siteId: "acme-b", name: "Acme", aliases: ["2 Main St"] },
      { ...base, id: "site:other", siteId: "other", name: "Other", aliases: ["2 Main St"] },
    ],
  };
  const sites = [
    { ...site, id: "acme-a", companyId: "acme", primary: false, address: "1 Main St" },
    { ...site, id: "acme-b", companyId: "acme", primary: true, address: "2 Main St" },
    { ...site, id: "other", companyId: "other", primary: true, address: "2 Main St" },
  ];
  assert.equal(id("Acme", { places: doc, sites }), "site:acme-b");
  assert.equal(id("1 main street", { places: doc, sites }), "site:acme-a");
  rejects("2 Main St", { places: doc, sites }, /ambiguous: 2 places/);
  assert.throws(() => resolvePlace("Acme", { places: doc, sites: [] }), /not in ctx.sites/);
});

// ---------- sf (post-integration) ----------

await test("sf: the spec query list [post-int]", () => {
  const dir = join(ROOT, "public/city/sf");
  if (!existsSync(join(dir, "manifest.json"))) return console.log("     skipped: public/city/sf not built yet");
  const version = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version;
  if (version !== CITY_VERSION) return console.log(`     skipped: public/city/sf is a v${version} build; this check reads v${CITY_VERSION} (waits for the v2 rebuild)`);
  const manifest = validateManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const walk = decodeWalk(new Uint8Array(readFileSync(join(dir, manifest.walk))), manifest);
  const ctx = {
    places: validatePlaces(JSON.parse(readFileSync(join(dir, manifest.places), "utf8")), manifest, walk),
    sites: validateCompanies(JSON.parse(readFileSync(join(dir, "companies.json"), "utf8")), manifest).sites,
  };
  assert.equal(id("Firegoat", ctx), "site:firegoat-501-2nd");
  assert.equal(id("501 2nd St", ctx), "site:firegoat-501-2nd");
  const x = resolvePlace("2nd & Howard", ctx);
  assert.equal(x.kind, "intersection");
  assert.equal(x.name, "2nd St & Howard St");
  assert.equal(id("howard and 2nd", ctx), x.id);
  assert.equal(id("Ferry Building", ctx), "lm:ferry-building");
  assert.equal(id("Oracle Park", ctx), "lm:oracle-park");
  assert.equal(id("Palace of Fine Arts", ctx), "lm:palace-of-fine-arts");
  assert.ok(rejects("Market", ctx, /ambiguous/).length >= 2);
});

console.log(`places.check: ${passed} passed`);
