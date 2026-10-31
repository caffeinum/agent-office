// Synthetic 4×4-chunk test city: `npm run city:fixture` writes public/city/fixture/**.
// Deterministic: running it twice gives byte-identical files (format.check compares against disk).
// Features: a hill rising to 30, a water strip with a pier and a building on it, a 4-wide road with
// sidewalks, 10 towers up to 100, a deck with pillars, a sloped lot (base/top rule), 3 companies (two share a tower).
import { gzipSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BLOCK_M, CHUNK, CITY_VERSION, COLUMNS, SF_PROJ, SURFACE, blockToLonLat, chunkKey, chunkOf, encodeChunk,
  lonLatToBlock, paletteFor, validateCompanies, validateManifest,
} from "../../public/shared/city.js";
import { renderTopdown } from "./lib/topdown.mjs";

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../public/city/fixture");
const CX0 = 56;
const CZ0 = 24;
const N = 4;
const W = N * CHUNK;
const X0 = CX0 * CHUNK;
const Z0 = CZ0 * CHUNK;
const BUILT_AT = "2026-10-31T00:00:00Z";
const VERIFIED_AT = "2026-10-31";

function createWorld() {
  return {
    ground: new Int16Array(W * W).fill(1),
    surface: new Uint8Array(W * W).fill(SURFACE.GRASS),
    deck: new Int16Array(W * W),
    owner: new Int32Array(W * W).fill(-1),
  };
}
const idx = (lx, lz) => lz * W + lx;
const rect = (x0, z0, x1, z1, fn) => {
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) fn(x, z, idx(x, z));
};
const isWaterAt = (lx, lz) => lx >= 208 || (lz >= 190 && lx >= 188);

function stampTerrain(w) {
  rect(0, 0, W - 1, W - 1, (x, z, i) => {
    const d = Math.hypot(x - 64, z - 64);
    if (d < 60) {
      w.ground[i] = Math.max(1, Math.round(30 * (1 - (d / 60) ** 2)));
      w.surface[i] = w.ground[i] >= 20 ? SURFACE.HILL : SURFACE.GRASS;
    }
    if (x >= 20 && x <= 60 && z >= 134 && z <= 175) w.ground[i] = 2 + Math.floor((x - 20) / 3);
    if (isWaterAt(x, z)) {
      w.ground[i] = 0;
      w.surface[i] = SURFACE.WATER;
    }
  });
  rect(0, 0, W - 1, W - 1, (x, z, i) => {
    if (w.surface[i] !== SURFACE.WATER) return;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, nz = z + dz;
      if (nx >= 0 && nz >= 0 && nx < W && nz < W && !isWaterAt(nx, nz)) w.surface[i] = SURFACE.SHALLOW;
    }
  });
  rect(140, 20, 180, 60, (x, z, i) => { w.surface[i] = SURFACE.PARK; });
  rect(106, 133, 186, 138, (x, z, i) => { w.surface[i] = SURFACE.PLAZA; });
  rect(208, 96, 235, 124, (x, z, i) => {
    w.ground[i] = 1;
    w.surface[i] = SURFACE.PIER;
  });
}

function stampRoads(w) {
  const road = (x0, z0, x1, z1, s) => rect(x0, z0, x1, z1, (x, z, i) => {
    if (w.ground[i] > 0) w.surface[i] = s;
  });
  road(0, 127, 207, 132, SURFACE.SIDEWALK);
  road(99, 0, 104, W - 1, SURFACE.SIDEWALK);
  road(0, 128, 207, 131, SURFACE.ROAD);
  road(100, 0, 103, W - 1, SURFACE.ROAD);
}

function stampDeck(w) {
  const deckY = 1 + 1 + 2;
  rect(8, 236, 92, 238, (x, z, i) => {
    w.deck[i] = z === 237 && (x - 8) % 12 === 0 ? -deckY : deckY;
  });
}

function defineBuildings() {
  const list = [];
  const heights = [100, 90, 80, 70, 60, 50, 40, 32, 24, 16];
  heights.forEach((h, k) => {
    list.push({ key: `fixture:tower-${String(k).padStart(2, "0")}`, x0: 112 + (k % 5) * 14, z0: 140 + Math.floor(k / 5) * 16, w: 6, d: 6, hBlocks: h });
  });
  [2, 3, 4, 8, 12].forEach((h, k) => {
    list.push({ key: `fixture:house-${k}`, x0: 112 + k * 8, z0: 176, w: 3, d: 3, hBlocks: h });
  });
  list.push({ key: "fixture:pier-shed", x0: 220, z0: 104, w: 10, d: 10, hBlocks: 4 });
  list.push({ key: "fixture:sloped-lot", x0: 30, z0: 138, w: 10, d: 10, hBlocks: 4 });
  list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return list.map((b, n) => ({ ...b, id: n + 1 }));
}

function stampBuildings(w, buildings) {
  for (const b of buildings) {
    let min = Infinity, max = -Infinity;
    rect(b.x0, b.z0, b.x0 + b.w - 1, b.z0 + b.d - 1, (x, z, i) => {
      if (w.ground[i] < 1) throw new Error(`fixture: ${b.key} stands on water at ${x},${z}`);
      min = Math.min(min, w.ground[i]);
      max = Math.max(max, w.ground[i]);
    });
    b.base = min;
    b.top = max + b.hBlocks;
    b.palette = paletteFor(b.top - b.base, b.id);
    rect(b.x0, b.z0, b.x0 + b.w - 1, b.z0 + b.d - 1, (x, z, i) => {
      w.owner[i] = b.id;
      w.ground[i] = b.base;
    });
  }
}

function toChunks(w, buildings) {
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const out = [];
  for (let cz = 0; cz < N; cz++) {
    for (let cx = 0; cx < N; cx++) {
      const c = { cx: CX0 + cx, cz: CZ0 + cz, ground: new Int16Array(COLUMNS), surface: new Uint8Array(COLUMNS), bldg: new Uint16Array(COLUMNS), deck: new Int16Array(COLUMNS), buildings: [] };
      const slot = new Map();
      let allWater = true;
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let lx = 0; lx < CHUNK; lx++) {
          const i = idx(cx * CHUNK + lx, cz * CHUNK + lz);
          const j = lz * CHUNK + lx;
          c.ground[j] = w.ground[i];
          c.surface[j] = w.surface[i];
          c.deck[j] = w.deck[i];
          const id = w.owner[i];
          if (id >= 0) {
            if (!slot.has(id)) {
              const b = byId.get(id);
              c.buildings.push({ id, base: b.base, top: b.top, palette: b.palette, roof: 0 });
              slot.set(id, c.buildings.length);
            }
            c.bldg[j] = slot.get(id);
          }
          if (w.surface[i] !== SURFACE.WATER || w.deck[i] !== 0 || id >= 0) allWater = false;
        }
      }
      if (!allWater) out.push(c);
    }
  }
  return out;
}

const ANCHOR_PREFERENCE = [SURFACE.SIDEWALK, SURFACE.PLAZA, SURFACE.ROAD];

function placeSite(w, buildings, spec) {
  const b = buildings.find((x) => x.key === spec.building);
  if (!b) throw new Error(`fixture: no building ${spec.building}`);
  const lx = b.x0 + spec.at[0];
  const lz = b.z0 + spec.at[1];
  if (w.owner[idx(lx, lz)] !== b.id) throw new Error(`fixture: ${spec.id} point is outside ${spec.building}`);
  const ll = blockToLonLat(X0 + lx + 0.5, Z0 + lz + 0.5);
  const lat = Number(ll.lat.toFixed(7));
  const lon = Number(ll.lon.toFixed(7));
  const p = lonLatToBlock(lon, lat);
  const block = { x: Math.floor(p.x), z: Math.floor(p.z) };
  if (block.x !== X0 + lx || block.z !== Z0 + lz) throw new Error(`fixture: ${spec.id} lat/lon rounding moved the column`);
  let anchor = null;
  for (const want of ANCHOR_PREFERENCE) {
    let best = Infinity;
    rect(Math.max(0, lx - 12), Math.max(0, lz - 12), Math.min(W - 1, lx + 12), Math.min(W - 1, lz + 12), (x, z, i) => {
      const d = Math.hypot(x - lx, z - lz);
      if (d <= 12 && d < best && w.owner[i] < 0 && w.surface[i] === want) {
        best = d;
        anchor = { x: X0 + x, y: w.ground[i], z: Z0 + z };
      }
    });
    if (anchor) break;
  }
  if (!anchor) throw new Error(`fixture: ${spec.id} has no sidewalk/plaza/road within 12 blocks`);
  return {
    id: spec.id, companyId: spec.companyId, name: spec.name, primary: true, address: spec.address, status: "hq",
    category: spec.category, color: spec.color,
    sources: [{ url: `https://example.com/${spec.companyId}/office`, kind: "occupancy", date: VERIFIED_AT }],
    verifiedAt: VERIFIED_AT, note: "synthetic fixture company", lat, lon,
    eas: { id: spec.easId, parcel: `FIXTURE-${spec.easId}` }, hintFrom: "fixture", buildingId: b.id, block,
    chunk: chunkOf(block.x, block.z), anchor, roofY: b.top, heightM: (b.top - b.base) * BLOCK_M,
    placement: "contains", placementDistM: 0,
  };
}

const SITES = [
  { id: "fixture-labs", companyId: "fixture-labs", name: "Fixture Labs", address: "1 Fixture Tower", category: "ai-lab", color: "#d97757", building: "fixture:tower-00", at: [1, 0], easId: 900001 },
  { id: "example-robotics", companyId: "example-robotics", name: "Example Robotics", address: "1 Fixture Tower", category: "robotics", color: "#4f7cff", building: "fixture:tower-00", at: [4, 0], easId: 900002 },
  { id: "sample-bakery", companyId: "sample-bakery", name: "Sample Bakery Co", address: "7 Slope Lane", category: "food", color: "#c08a3e", building: "fixture:sloped-lot", at: [4, 0], easId: 900003 },
];

/** → Map of path (relative to public/city/fixture) → bytes. */
export function generateFixture() {
  const w = createWorld();
  stampTerrain(w);
  stampRoads(w);
  stampDeck(w);
  const buildings = defineBuildings();
  stampBuildings(w, buildings);
  const chunks = toChunks(w, buildings);
  const files = new Map();
  const list = [];
  let yMin = Infinity, yMax = -Infinity;
  for (const c of chunks) {
    const gz = gzipSync(encodeChunk(c), { level: 9 });
    files.set(`chunks/${chunkKey(c.cx, c.cz)}.bin`, gz);
    list.push([c.cx, c.cz, gz.length]);
    for (let i = 0; i < COLUMNS; i++) {
      yMin = Math.min(yMin, c.ground[i]);
      yMax = Math.max(yMax, c.ground[i], Math.abs(c.deck[i]));
    }
    for (const b of c.buildings) yMax = Math.max(yMax, b.top);
  }
  const manifest = validateManifest({
    version: CITY_VERSION, city: "fixture", name: "Fixture City", blockM: BLOCK_M, chunk: CHUNK, proj: { ...SF_PROJ },
    chunks: { min: [CX0, CZ0], max: [CX0 + N - 1, CZ0 + N - 1], list },
    yRange: [yMin, yMax], spawn: { x: X0 + W / 2, z: Z0 + W / 2, dist: 400 },
    attribution: ["Synthetic test city generated by scripts/city/fixture.mjs; no map data."],
    sources: [{ id: "fixture", url: "https://github.com/caffeinum/agent-office/blob/main/scripts/city/fixture.mjs", license: "MIT" }],
    builtAt: BUILT_AT,
  });
  const companies = validateCompanies({ version: CITY_VERSION, city: "fixture", builtAt: BUILT_AT, sites: SITES.map((s) => placeSite(w, buildings, s)) }, manifest);
  files.set("manifest.json", Buffer.from(JSON.stringify(manifest, null, 1) + "\n"));
  files.set("companies.json", Buffer.from(JSON.stringify(companies, null, 1) + "\n"));
  files.set("topdown.png", renderTopdown(manifest, new Map(chunks.map((c) => [chunkKey(c.cx, c.cz), c]))));
  return files;
}

export function writeFixture(dir = FIXTURE_DIR) {
  const files = generateFixture();
  rmSync(join(dir, "chunks"), { recursive: true, force: true });
  for (const [rel, bytes] of files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
  }
  const total = [...files.values()].reduce((n, b) => n + b.length, 0);
  console.log(`fixture: ${files.size} files, ${total} bytes → ${dir}`);
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeFixture();

