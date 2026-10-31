// W3 checks: EAS normalisation and hit picking, the section 4 source rules, the real roster, and
// companies.json placement against decoded chunks (fixture always; sf once W2's build exists).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CITY_VERSION, SURFACE, lonLatToBlock, validateCompanies, validateManifest } from "../../../public/shared/city.js";

/** SF EAS address point for 501 2nd St (eas_baseid 366241, dataset 3mea-di5p; also asserted in format.check). */
const FIREGOAT_EAS = Object.freeze({ id: 366241, lat: 37.78293133749337, lon: -122.39320537355528 });
import { easQueryUrl, normalizeAddress, pickEasHit, resolveEas } from "../lib/eas.mjs";
import { ANCHOR_RADIUS, PLACE_RADIUS, buildCompanies, checkSource, createColumnReader } from "../companies-sf.mjs";

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

// ---------- normalisation ----------

await test("normalize: suite, unit, floor and # parts are stripped", () => {
  const cases = [
    ["100 First Street, Suite 600, San Francisco, CA 94105", { number: 100, street: "1ST", type: "ST", range: null }],
    ["444 De Haro Street #200", { number: 444, street: "DE HARO", type: "ST", range: null }],
    ["760 Market St Floor 10", { number: 760, street: "MARKET", type: "ST", range: null }],
    ["415 Mission Street 3rd Fl", { number: 415, street: "MISSION", type: "ST", range: null }],
    ["350 Mission St., 10th Floor", { number: 350, street: "MISSION", type: "ST", range: null }],
    ["101 Spear St Ste 500", { number: 101, street: "SPEAR", type: "ST", range: null }],
    ["  221   main   street   unit 6 ", { number: 221, street: "MAIN", type: "ST", range: null }],
  ];
  for (const [input, want] of cases) assert.deepEqual(normalizeAddress(input), want, input);
});

await test("normalize: spelled ordinals become numeric (THIRD → 3RD)", () => {
  assert.deepEqual(normalizeAddress("1455 Third Street"), { number: 1455, street: "3RD", type: "ST", range: null });
  assert.equal(normalizeAddress("303 Second St").street, "2ND");
  assert.equal(normalizeAddress("525 Twentieth Street").street, "20TH");
  assert.equal(normalizeAddress("1455 3rd St").street, "3RD");
  assert.equal(normalizeAddress("1455 03RD ST").street, "3RD", "EAS zero padding normalises away");
});

await test("normalize: street types are abbreviated", () => {
  assert.equal(normalizeAddress("3250 Van Ness Avenue").type, "AVE");
  assert.equal(normalizeAddress("550 Terry A Francois Boulevard").type, "BLVD");
  assert.equal(normalizeAddress("1 Pier Place").type, "PL");
  assert.deepEqual(normalizeAddress("300 Toni Stone Crossing"), { number: 300, street: "TONI STONE", type: "XING", range: null });
  assert.deepEqual(normalizeAddress("1 The Embarcadero"), { number: 1, street: "THE EMBARCADERO", type: null, range: null });
});

await test("normalize: a number range queries the first number and keeps the range", () => {
  assert.deepEqual(normalizeAddress("1455-1515 3rd St"), { number: 1455, street: "3RD", type: "ST", range: "1455-1515" });
  assert.deepEqual(normalizeAddress("1455 - 1515 Third Street, Suite 1"), { number: 1455, street: "3RD", type: "ST", range: "1455-1515" });
});

await test("normalize: bad input throws", () => {
  assert.throws(() => normalizeAddress("Salesforce Tower"), /no street number/);
  assert.throws(() => normalizeAddress(""), /non-empty/);
  assert.throws(() => normalizeAddress(null), /non-empty/);
});

await test("easQueryUrl: pins the EAS columns and zero-pads single-digit ordinals", () => {
  const u = new URL(easQueryUrl(normalizeAddress("1455 Third Street")));
  assert.equal(u.origin + u.pathname, "https://data.sf.gov/resource/3mea-di5p.json");
  assert.equal(u.searchParams.get("$where"), "address_number=1455 AND address_number_suffix IS NULL AND street_name='03RD' AND street_type='ST'");
  assert.match(u.searchParams.get("$select"), /eas_baseid.*parcel_number.*latitude.*longitude/);
  const w = new URL(easQueryUrl(normalizeAddress("525 20th St"))).searchParams.get("$where");
  assert.match(w, /street_name='20TH'/);
  const noType = new URL(easQueryUrl(normalizeAddress("1 The Embarcadero"))).searchParams.get("$where");
  assert.doesNotMatch(noType, /street_type/);
  assert.match(new URL(easQueryUrl({ number: 1, street: "O'FARRELL", type: "ST", range: null })).searchParams.get("$where"), /'O''FARRELL'/);
});

// ---------- multiple hits ----------

const hit = (id, lat, lon, parcel = `P${id}`) => ({ id, parcel, lat, lon, number: 1, street: "X", type: "ST" });

await test("pickEasHit: hits within 10 m → lowest id", () => {
  const hits = [hit(30, 37.79, -122.4), hit(12, 37.79004, -122.4), hit(20, 37.79, -122.40005)];
  assert.equal(pickEasHit(hits).id, 12);
});

await test("pickEasHit: hits spread over 10 m need easId", () => {
  const hits = [hit(30, 37.79, -122.4), hit(12, 37.7902, -122.4)];
  assert.throws(() => pickEasHit(hits), /set easId/);
  assert.equal(pickEasHit(hits, { easId: 30 }).id, 30);
  assert.throws(() => pickEasHit(hits, { easId: 99 }), /not among the hits/);
  assert.throws(() => pickEasHit([]), /no EAS match/);
});

await test("resolveEas: caches, checks the hint distance and names hint.from", async () => {
  const rawDir = mkdtempSync(join(tmpdir(), "eas-check-"));
  try {
    let calls = 0;
    const rows = [
      { eas_baseid: "489890", address_number: "1455", street_name: "03RD", street_type: "ST", parcel_number: "8721033", latitude: "37.77006096459158", longitude: "-122.38877258125436" },
      { eas_baseid: "1", address_number: "1455", street_name: "03RD", street_type: "AVE", parcel_number: "1", latitude: "37.7", longitude: "-122.4" },
    ];
    const fetchRows = async () => (calls++, rows);
    const entry = { id: "openai-1455-3rd", address: "1455 Third Street", hint: { lat: 37.7700459, lon: -122.3887896, from: "https://example.org/hint" } };
    const r = await resolveEas(entry, { rawDir, fetchRows });
    assert.deepEqual({ id: r.id, parcel: r.parcel }, { id: 489890, parcel: "8721033" }, "type filter drops the AVE row");
    assert.ok(r.distM < 3);
    await resolveEas(entry, { rawDir, fetchRows });
    assert.equal(calls, 1, "second resolve reads raw/eas/<id>.json");
    assert.ok(existsSync(join(rawDir, "eas", "openai-1455-3rd.json")));
    const far = { ...entry, id: "far", hint: { lat: 37.7712, lon: -122.3887896, from: "https://example.org/far-hint" } };
    await assert.rejects(resolveEas(far, { rawDir, fetchRows }), /m from the hint .*https:\/\/example\.org\/far-hint/);
    await assert.rejects(resolveEas({ ...entry, id: "none" }, { rawDir, fetchRows: async () => [] }), /no match/);
    const noParcel = [{ ...rows[0], parcel_number: undefined }];
    await assert.rejects(resolveEas({ ...entry, id: "noparcel" }, { rawDir, fetchRows: async () => noParcel }), /no parcel_number/);
  } finally {
    rmSync(rawDir, { recursive: true, force: true });
  }
});

// ---------- source rules ----------

const base = () => ({
  id: "acme-hq", companyId: "acme", name: "Acme", primary: true, address: "1 Main St", status: "hq", category: "x", color: "#123456",
  sources: [{ url: "https://acme.example/contact", kind: "occupancy", date: "2026-01-01" }], verifiedAt: "2026-10-31",
  hint: { lat: 37.79, lon: -122.39, from: "https://example.org/h" }, ship: true,
});

await test("rule 1: occupancy for hq/office, dated news for former, registry is never enough", () => {
  assert.equal(checkSource([base()]).shipped.length, 1);
  assert.throws(() => checkSource([{ ...base(), sources: [{ url: "https://data.sf.gov/x", kind: "registry" }] }]), /needs an occupancy or operator source/);
  assert.throws(() => checkSource([{ ...base(), status: "office", sources: [{ url: "https://n.example/a", kind: "news", date: "2026-01-01" }] }]), /needs an occupancy or operator source/);
  assert.throws(() => checkSource([{ ...base(), sources: [] }]), /at least one source/);
  assert.throws(() => checkSource([{ ...base(), status: "former", sources: [{ url: "https://n.example/a", kind: "news" }] }]), /dated news or company/);
  assert.equal(checkSource([{ ...base(), status: "former", sources: [{ url: "https://n.example/a", kind: "news", date: "2024-08-05" }] }]).shipped.length, 1);
  const { shipped, skipped } = checkSource([{ ...base(), ship: false, sources: [], note: "scout memory only" }]);
  assert.deepEqual([shipped.length, skipped.length], [0, 1], "unshipped leads are not held to rule 1");
  assert.throws(() => checkSource([{ ...base(), ship: false }]), /needs a note/);
});

await test("source shape: unknown fields, bad hint, duplicate ids throw", () => {
  assert.throws(() => checkSource([{ ...base(), extra: 1 }]), /unknown field extra/);
  assert.throws(() => checkSource([{ ...base(), hint: { lat: 1, lon: 2, from: "memory" } }]), /hint.from/);
  assert.throws(() => checkSource([base(), base()]), /duplicate id/);
  assert.throws(() => checkSource([{ ...base(), status: "moved" }]), /status/);
});

await test("rules 7 and 8: one primary per company, newest occupancy is the hq", () => {
  const office = { ...base(), id: "acme-2", primary: false, status: "office", sources: [{ url: "https://n.example/lease", kind: "occupancy", date: "2025-06-01" }] };
  assert.equal(checkSource([base(), office]).shipped.length, 2);
  assert.throws(() => checkSource([base(), { ...office, primary: true }]), /2 primary sites/);
  assert.throws(() => checkSource([{ ...base(), primary: false }, office]), /0 primary sites/);
  assert.throws(() => checkSource([base(), { ...office, sources: [{ url: "https://n.example/lease", kind: "occupancy", date: "2026-05-01" }] }]), /newer occupancy source/);
  assert.throws(() => checkSource([base(), { ...office, status: "hq" }]), /must be office/);
  assert.throws(() => checkSource([{ ...base(), status: "office" }, office]), /must have status hq/);
});

await test("accessed vs date: rule 8 compares publication dates only", () => {
  const office = { ...base(), id: "acme-2", primary: false, status: "office", sources: [{ url: "https://n.example/lease", kind: "occupancy", date: "2025-06-01" }] };
  const readOnly = { ...base(), sources: [{ url: "https://acme.example/contact", kind: "occupancy", accessed: "2026-10-31" }] };
  assert.equal(checkSource([readOnly]).shipped.length, 1, "an undated page read on a date is still an occupancy source");
  assert.throws(() => checkSource([readOnly, office]), /primary acme-hq needs a dated occupancy source/);
  assert.throws(() => checkSource([{ ...base(), sources: [{ url: "https://a.example/", kind: "occupancy", date: "2026-01-01", accessed: "2025-01-01" }] }]), /before the publication date/);
  assert.throws(() => checkSource([{ ...base(), sources: [{ url: "https://a.example/", kind: "occupancy", accessed: "31/10/2026" }] }]), /accessed must be YYYY-MM-DD/);
});

await test("operator statements: a cited-nowhere address must be marked as the operator's word", () => {
  const op = { kind: "operator", statement: "the operator says so", date: "2026-10-31" };
  assert.equal(checkSource([{ ...base(), sources: [op], note: "rests on the operator's statement" }]).shipped.length, 1);
  assert.throws(() => checkSource([{ ...base(), sources: [op] }]), /must say so in its note/);
  assert.throws(() => checkSource([{ ...base(), sources: [{ ...op, url: "https://x.example/" }], note: "operator" }]), /unknown field url/);
  assert.throws(() => checkSource([{ ...base(), sources: [{ kind: "operator", date: "2026-10-31" }], note: "operator" }]), /needs \{kind, statement, date\}/);
});

await test("building override: shape is checked", () => {
  const b = { lat: 37.79, lon: -122.39, from: "https://www.openstreetmap.org/way/1", reason: "why" };
  assert.equal(checkSource([{ ...base(), building: b }]).shipped.length, 1);
  assert.throws(() => checkSource([{ ...base(), building: { ...b, reason: "" } }]), /building override/);
  assert.throws(() => checkSource([{ ...base(), building: { ...b, from: "memory" } }]), /building override/);
});

// ---------- the real roster ----------

await test("roster: ≥ 40 shipped sites meeting rule 1, all leads explained", () => {
  const src = readJson("scripts/city/sf/companies.src.json");
  const { shipped, skipped } = checkSource(src);
  assert.ok(shipped.length >= 40, `${shipped.length} shipped sites`);
  for (const s of skipped) assert.ok(s.reason.startsWith("Not shipped:"), `${s.id}: ${s.reason}`);
  for (const e of shipped) assert.equal(e.verifiedAt, "2026-10-31", e.id);
  assert.equal(shipped.filter((e) => e.hint.from === "scout").length, 0, "no shipped site rests on a scout hint");
  const formers = shipped.filter((e) => e.status === "former").map((e) => e.companyId).sort();
  assert.deepEqual(formers, ["block", "pge", "x"]);
  for (const e of shipped.filter((x) => x.status === "former")) {
    for (const s of e.sources) assert.notEqual(s.kind, "occupancy", `${e.id}: a former site's sources document the departure, not occupancy (${s.url})`);
  }
  for (const e of shipped) for (const s of e.sources) if (s.date) assert.ok(s.date <= e.verifiedAt, `${e.id}: publication date ${s.date} after verifiedAt`);
});

await test("roster: Anthropic rule 8 decision and OpenAI campus are recorded", () => {
  const src = readJson("scripts/city/sf/companies.src.json");
  const anthropic = src.filter((e) => e.companyId === "anthropic" && e.ship);
  const primary = anthropic.find((e) => e.primary);
  assert.equal(primary.address, "500 Howard St");
  assert.equal(primary.status, "hq");
  assert.match(primary.note, /Rule 8/);
  assert.ok(primary.sources.some((s) => s.kind === "occupancy" && s.date), "primary has a dated occupancy source");
  for (const e of anthropic.filter((x) => !x.primary)) assert.equal(e.status, "office", e.id);
  const openai = src.filter((e) => e.companyId === "openai" && e.ship);
  assert.equal(openai.find((e) => e.primary).address, "1455 3rd St");
  assert.ok(openai.length >= 3);
});

// ---------- placement against chunks ----------

/** buildingId exists in the chunk grid near `block`, roof and height agree, the anchor is land and not a building. */
function verifyAgainstChunks(doc, manifest, chunksDir) {
  validateCompanies(doc, manifest);
  const columnAt = createColumnReader(manifest, chunksDir);
  for (const s of doc.sites) {
    const here = columnAt(s.block.x, s.block.z);
    assert.ok(here, `${s.id}: block outside the city`);
    let found = null;
    if (s.placement === "contains") {
      assert.ok(here.building, `${s.id}: contains, but block ${s.block.x},${s.block.z} is not a building`);
      found = here.building;
    } else {
      for (let dz = -PLACE_RADIUS; dz <= PLACE_RADIUS && !found; dz++) {
        for (let dx = -PLACE_RADIUS; dx <= PLACE_RADIUS && !found; dx++) {
          const c = columnAt(s.block.x + dx, s.block.z + dz);
          if (c?.building?.id === s.buildingId) found = c.building;
        }
      }
    }
    assert.ok(found, `${s.id}: building ${s.buildingId} not found near ${s.block.x},${s.block.z}`);
    assert.equal(found.id, s.buildingId, `${s.id}: buildingId`);
    assert.ok(found.top <= s.roofY, `${s.id}: chunk entry top ${found.top} above roofY ${s.roofY}`);
    assert.equal(columnAt.roofOf(s.buildingId), s.roofY, `${s.id}: roofY is the max entry top over every chunk`);
    assert.equal((s.roofY - found.base) * 3, s.heightM, `${s.id}: heightM`);
    const a = columnAt(s.anchor.x, s.anchor.z);
    assert.ok(a, `${s.id}: anchor outside the city`);
    assert.equal(a.building, null, `${s.id}: anchor column is a building`);
    assert.ok(a.surface !== SURFACE.WATER && a.surface !== SURFACE.SHALLOW, `${s.id}: anchor column is water`);
    assert.equal(a.ground, s.anchor.y, `${s.id}: anchor.y`);
    assert.ok(Math.hypot(s.anchor.x - s.block.x, s.anchor.z - s.block.z) <= ANCHOR_RADIUS, `${s.id}: anchor too far`);
  }
}

await test("fixture: companies.json places against the decoded chunks", () => {
  const manifest = validateManifest(readJson("public/city/fixture/manifest.json"));
  verifyAgainstChunks(readJson("public/city/fixture/companies.json"), manifest, join(ROOT, "public/city/fixture/chunks"));
});

await test("fixture: buildCompanies re-places the 3 fixture companies identically, incl. the shared tower", async () => {
  const fixture = readJson("public/city/fixture/companies.json");
  const src = fixture.sites.map((s) => ({
    id: s.id, companyId: s.companyId, name: s.name, primary: s.primary, address: s.address, status: s.status, category: s.category,
    color: s.color, sources: s.sources, verifiedAt: s.verifiedAt, hint: { lat: s.lat, lon: s.lon, from: "https://example.com/fixture" },
    note: s.note, ship: true,
  }));
  const bySite = new Map(fixture.sites.map((s) => [s.id, s]));
  const resolve = async (e) => {
    const s = bySite.get(e.id);
    return { id: s.eas.id, parcel: s.eas.parcel, lat: s.lat, lon: s.lon, distM: 0, range: null };
  };
  const { doc, report } = await buildCompanies({ src, manifestPath: join(ROOT, "public/city/fixture/manifest.json"), resolve, write: false });
  const want = fixture.sites.map((s) => ({ ...s, hintFrom: "https://example.com/fixture" }));
  assert.deepEqual(doc.sites, want);
  assert.equal(doc.builtAt, fixture.builtAt);
  const shared = doc.sites.filter((s) => s.buildingId === doc.sites[0].buildingId);
  assert.equal(shared.length, 2, "two companies share tower-00");
  assert.equal(report.shipped, 3);
});

await test("fixture: placement falls back to the nearest building and fails loudly off the grid", async () => {
  const fixture = readJson("public/city/fixture/companies.json");
  const manifestPath = join(ROOT, "public/city/fixture/manifest.json");
  const s0 = fixture.sites[0];
  const src = [{
    id: s0.id, companyId: s0.companyId, name: s0.name, primary: true, address: s0.address, status: "hq", category: s0.category,
    color: s0.color, sources: s0.sources, verifiedAt: s0.verifiedAt, hint: { lat: s0.lat, lon: s0.lon, from: "https://example.com/fixture" }, ship: true,
  }];
  // the anchor column is sidewalk next to the tower, so a point there must snap to the tower as "nearest"
  const { blockToLonLat } = await import("../../../public/shared/city.js");
  const at = (x, z) => async () => {
    const ll = blockToLonLat(x + 0.5, z + 0.5);
    return { id: 1, parcel: "P", lat: Number(ll.lat.toFixed(7)), lon: Number(ll.lon.toFixed(7)), distM: 0, range: null };
  };
  const near = await buildCompanies({ src, manifestPath, resolve: at(s0.anchor.x, s0.anchor.z), write: false });
  assert.equal(near.doc.sites[0].placement, "nearest");
  assert.ok(near.doc.sites[0].placementDistM > 0 && near.doc.sites[0].placementDistM <= 45);
  verifyAgainstChunks(near.doc, validateManifest(readJson("public/city/fixture/manifest.json")), join(ROOT, "public/city/fixture/chunks"));
  // chunk 59_27 is open water (not written): no building within 15 blocks
  await assert.rejects(buildCompanies({ src, manifestPath, resolve: at(59 * 64 + 40, 27 * 64 + 40), write: false }), /rule 4/);
  // rule 3: outside the manifest range the site is listed as skipped, not shipped
  const out = await buildCompanies({ src, manifestPath, resolve: at(10, 10), write: false });
  assert.deepEqual([out.doc.sites.length, out.report.outsideBbox.map((o) => o.id)], [0, [s0.id]]);
  // ...but a primary outside with another site of the company inside fails
  const office = { ...src[0], id: "fixture-labs-2", primary: false, status: "office" };
  const split = async (e) => (e.id === s0.id ? at(10, 10)() : at(s0.block.x, s0.block.z)());
  await assert.rejects(buildCompanies({ src: [...src, office], manifestPath, resolve: split, write: false }), /rule 3: primary is outside/);
});

// ---------- sf (post-integration) ----------

await test("sf: companies.json against the real chunks [post-int]", () => {
  const manifestPath = join(ROOT, "public/city/sf/manifest.json");
  const companiesPath = join(ROOT, "public/city/sf/companies.json");
  if (!existsSync(manifestPath) || !existsSync(companiesPath)) {
    console.log("     skipped: public/city/sf not built yet (W2 + npm run city:build)");
    return;
  }
  const version = JSON.parse(readFileSync(manifestPath, "utf8")).version;
  if (version !== CITY_VERSION) {
    console.log(`     skipped: public/city/sf is a v${version} build; this check reads v${CITY_VERSION} (waits for the v2 rebuild)`);
    return;
  }
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const doc = JSON.parse(readFileSync(companiesPath, "utf8"));
  verifyAgainstChunks(doc, manifest, join(ROOT, "public/city/sf/chunks"));
  assert.ok(doc.sites.length >= 40, `${doc.sites.length} sites`);
  const sf = doc.sites.find((s) => s.id === "salesforce-tower");
  assert.ok(sf.heightM >= 300, `Salesforce heightM ${sf.heightM}`);
  const openai = doc.sites.find((s) => s.companyId === "openai" && s.primary);
  assert.equal(openai.address, "1455 3rd St");
  const slack = doc.sites.find((s) => s.id === "slack-salesforce-tower");
  assert.equal(slack.buildingId, sf.buildingId, "415 Mission is shared by Salesforce and Slack");
  const pge = doc.sites.find((s) => s.id === "pge-77-beale");
  assert.equal(pge.placement, "override");
  assert.ok(pge.heightM >= 140 && pge.heightM <= 160, `77 Beale is the ~150 m PG&E Building, got ${pge.heightM} m`);
  // spec-v2 §6: Firegoat sits on the SF EAS address point for 501 2nd St, on the footprint containing it
  const fg = doc.sites.find((s) => s.id === "firegoat-501-2nd");
  assert.ok(fg, "Firegoat ships");
  assert.equal(fg.eas.id, FIREGOAT_EAS.id);
  const p = lonLatToBlock(FIREGOAT_EAS.lon, FIREGOAT_EAS.lat, manifest.proj);
  assert.ok(Math.hypot(fg.block.x + 0.5 - p.x, fg.block.z + 0.5 - p.z) <= 1, `Firegoat block ${fg.block.x},${fg.block.z} vs EAS ${p.x.toFixed(1)},${p.z.toFixed(1)}`);
  assert.equal(fg.placement, "contains", "the EAS point lies on the building footprint containing it");
  const yc = doc.sites.find((s) => s.companyId === "y-combinator");
  assert.ok(yc && yc.address === "560 20th St", "Y Combinator ships at its Pier 70 registry address");
});

console.log(`companies.check: ${passed} passed`);
