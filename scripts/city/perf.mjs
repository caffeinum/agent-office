// `npm run city:perf [-- --city fixture] [-- --gate]`: mesher timings and a simulated frame budget.
// 1. Times meshChunk on chunk (76,56) (target ≤ 15 ms) and meshRegion at LOD1/LOD2 on its region.
// 2. Frame budget (spec-v2 §2, §8 W4): for the `spawn` and `presidio` (overview) cameras it picks the same LOD set
//    as scene.js (LOD0 ring 1, LOD1 regions within 5 chunks, LOD2 beyond, skips drawn at LOD0), meshes it, adds the
//    unbuilt-land mesh and the instanced landmark layer, frustum-culls every mesh by its bounding box at 1280×800,
//    and counts triangles and draw calls (main pass + sun shadow pass for casters inside the shadow box + the
//    output pass). Gate: ≤ 1.5M triangles after culling and ≤ 90 draw calls. With --gate a miss exits non-zero.
//    LOD0 chunks carry their street.bin detail (decals, furniture, parked cars), and cameras within TRAFFIC_DIST add
//    the three instanced traffic meshes at their caps (main + shadow). A third preset stands at street level on
//    2nd St at Howard.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  CHUNK, REGION, chunkKey, chunkOf, decodeChunk, decodeLandmarks, decodeLandmask, decodeStreet, lonLatToBlock, regionOf, validateManifest,
} from "../../public/shared/city.js";
import { binStreet } from "../../public/js/city/streetmesh.js";
import { CABLE_CAR_BOXES, CAR_BOXES, DECAL_DIST, STREETCAR_BOXES } from "../../public/js/city/streetkit.js";
import { MAX_CARS, TRAFFIC_DIST } from "../../public/js/city/traffic.js";
import { meshChunk, meshRegion, meshUnbuilt } from "../../public/js/city/mesher.js";
import { landmarkTriangles } from "../../public/js/city/meshlayer.js";
import { createUnmapped } from "../../public/js/city/unmapped.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET = [76, 56]; // the largest v2 sf chunk (FiDi/North Beach)
const TARGET_MS = 15;
const RUNS = 30;
export const FRAME_BUDGET = Object.freeze({ triangles: 1_500_000, calls: 90 });
/** Mirrors scene.js / stage.js. */
const LOD0_R = 1, LOD1_R = 5;
const VIEW = { w: 1280, h: 800, fov: 30, near: 1, far: 6000 };
const SHADOW_HALF = 128;
const OUTPUT_PASS_CALLS = 1;
const WATER_PLANE_CALLS = 1;
const DEFAULT_POLAR = 0.95;
/** Presidio overview camera target, roughly over the Main Post (a viewpoint, not map data). */
const PRESIDIO = { lon: -122.4662, lat: 37.7989, dist: 1500, polar: 0.9 };
/** Street-level camera on 2nd St looking north toward Howard (a viewpoint, not map data). */
const STREET = { lon: -122.39826, lat: 37.78655, dist: 16, polar: 1.36, az: 0.15 };
/** Traffic at its caps: cars, cable cars, streetcars (12 triangles per box). */
const TRAFFIC_TRIANGLES = 12 * (MAX_CARS * CAR_BOXES.length + 8 * CABLE_CAR_BOXES.length + 8 * STREETCAR_BOXES.length);
const TRAFFIC_MESHES = 3;

function load(city) {
  const dir = join(ROOT, "public/city", city);
  if (!existsSync(join(dir, "manifest.json"))) {
    throw new Error(`city:perf: ${dir}/manifest.json not found; run npm run city:build, or pass --city fixture`);
  }
  const manifest = validateManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
  const chunks = new Map();
  for (const [cx, cz] of manifest.chunks.list) {
    chunks.set(chunkKey(cx, cz), decodeChunk(new Uint8Array(gunzipSync(readFileSync(join(dir, "chunks", `${chunkKey(cx, cz)}.bin`)))), manifest.parents));
  }
  const mask = decodeLandmask(new Uint8Array(gunzipSync(readFileSync(join(dir, manifest.landmask)))), manifest.chunks.grid);
  const boxes = decodeLandmarks(new Uint8Array(gunzipSync(readFileSync(join(dir, manifest.landmarks)))), manifest.chunks.grid);
  const street = binStreet(decodeStreet(new Uint8Array(gunzipSync(readFileSync(join(dir, manifest.street)))), manifest.chunks.grid));
  return { manifest, mask, boxes, street, get: (cx, cz) => chunks.get(chunkKey(cx, cz)) ?? null };
}

function time(fn) {
  for (let k = 0; k < 3; k++) fn();
  const ms = [];
  let out;
  for (let k = 0; k < RUNS; k++) {
    const t = performance.now();
    out = fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return { out, median: ms[RUNS >> 1], p90: ms[Math.floor(RUNS * 0.9)] };
}

const tris = (m) => m.indices.length / 3;
const fmt = (t) => `median ${t.median.toFixed(2)} ms, p90 ${t.p90.toFixed(2)} ms`;

// ---------- camera + frustum ----------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Pure. Orbit camera {x, z, y, dist, az, polar} → clip(p) → [x, y, z, w] (THREE conventions). */
export function cameraClip({ x, y, z, dist, az, polar }, view = VIEW) {
  const eye = [x + dist * Math.sin(polar) * Math.sin(az), y + dist * Math.cos(polar), z + dist * Math.sin(polar) * Math.cos(az)];
  const f = norm(sub([x, y, z], eye));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  const t = 1 / Math.tan(((view.fov / 2) * Math.PI) / 180);
  const aspect = view.w / view.h;
  const { near: n, far: fa } = view;
  return (p) => {
    const d = sub(p, eye);
    const vx = dot(d, r), vy = dot(d, u), vz = -dot(d, f);
    return [(t / aspect) * vx, t * vy, ((fa + n) / (n - fa)) * vz + ((2 * fa * n) / (n - fa)), -vz];
  };
}

/** Pure. Is the AABB [min, max] (world) entirely outside one clip plane? */
export function culled(clip, min, max) {
  const out = [0, 0, 0, 0, 0, 0];
  for (let k = 0; k < 8; k++) {
    const [x, y, z, w] = clip([k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]]);
    if (x < -w) out[0]++; if (x > w) out[1]++;
    if (y < -w) out[2]++; if (y > w) out[3]++;
    if (z < -w) out[4]++; if (z > w) out[5]++;
  }
  return out.some((n) => n === 8);
}

function bounds(m) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < m.positions.length; v += 3) {
    for (let a = 0; a < 3; a++) {
      const p = m.positions[v + a] + m.origin[a];
      if (p < min[a]) min[a] = p;
      if (p > max[a]) max[a] = p;
    }
  }
  return { min, max };
}

/** The scene.js LOD set for a camera target, meshed. → [{what, mesh, shadow}] */
function frameMeshes(city, target, dist = 0) {
  const { manifest, get, mask } = city;
  const unmapped = createUnmapped(manifest, mask);
  const [tcx, tcz] = chunkOf(Math.floor(target.x), Math.floor(target.z));
  const out = [];
  const lod0 = new Set();
  for (const [cx, cz] of manifest.chunks.list) {
    if (Math.max(Math.abs(cx - tcx), Math.abs(cz - tcz)) > LOD0_R) continue;
    lod0.add(chunkKey(cx, cz));
    const nb = (x, z, side) => get(x, z) ?? unmapped.neighbour(x, z, side);
    const m = meshChunk(get(cx, cz), { n: nb(cx, cz - 1, "n"), s: nb(cx, cz + 1, "s"), e: nb(cx + 1, cz, "e"), w: nb(cx - 1, cz, "w") }, city.street.get(chunkKey(cx, cz)) ?? null);
    for (const [k, mesh] of Object.entries(m)) if (k !== "decals" || dist < DECAL_DIST) out.push({ what: `lod0 ${cx},${cz} ${k}`, mesh, shadow: k !== "decals" });
  }
  const regions = new Map();
  for (const [cx, cz] of manifest.chunks.list) {
    const key = regionOf(cx, cz).join("_");
    if (!regions.has(key)) regions.set(key, []);
    regions.get(key).push([cx, cz]);
  }
  for (const [key, list] of regions) {
    let ring = Infinity;
    for (const [cx, cz] of list) ring = Math.min(ring, Math.max(Math.abs(cx - tcx), Math.abs(cz - tcz)));
    const lod = ring <= LOD1_R ? 1 : 2;
    const skip = list.filter(([cx, cz]) => lod0.has(chunkKey(cx, cz)));
    const chunks = list.filter(([cx, cz]) => !lod0.has(chunkKey(cx, cz))).map(([cx, cz]) => get(cx, cz));
    if (!chunks.length) continue;
    out.push({ what: `region ${key} lod ${lod}`, mesh: meshRegion(chunks, skip, lod).opaque, shadow: false });
  }
  out.push({ what: "unbuilt", mesh: meshUnbuilt(mask, manifest.chunks.list.map(([cx, cz]) => [cx, cz]), manifest.water, manifest.proj).opaque, shadow: false });
  return out;
}

/** → {triangles, calls, mainCalls, shadowCalls, meshes, culledMeshes} for one camera. */
export function frameBudget(city, cam) {
  const meshes = frameMeshes(city, cam, cam.dist);
  const clip = cameraClip({ ...cam, y: cam.y ?? 0 });
  let triangles = 0, mainCalls = 0, shadowCalls = 0, culledMeshes = 0;
  const shadowMin = [cam.x - SHADOW_HALF * 2, -Infinity, cam.z - SHADOW_HALF * 2], shadowMax = [cam.x + SHADOW_HALF * 2, Infinity, cam.z + SHADOW_HALF * 2];
  for (const { mesh, shadow } of meshes) {
    if (!mesh.indices.length) continue;
    const { min, max } = bounds(mesh);
    if (culled(clip, min, max)) { culledMeshes++; continue; }
    triangles += tris(mesh);
    mainCalls++;
    if (shadow && max[0] >= shadowMin[0] && min[0] <= shadowMax[0] && max[2] >= shadowMin[2] && min[2] <= shadowMax[2]) shadowCalls++;
  }
  if (city.boxes.length) {
    triangles += landmarkTriangles(city.boxes);
    const groups = new Set(city.boxes.map((b) => b.flags & 1)).size;
    mainCalls += groups;
    shadowCalls += groups;
  }
  if (cam.dist < TRAFFIC_DIST) {
    triangles += TRAFFIC_TRIANGLES;
    mainCalls += TRAFFIC_MESHES;
    shadowCalls += TRAFFIC_MESHES;
  }
  return { triangles, calls: mainCalls + shadowCalls + OUTPUT_PASS_CALLS + WATER_PLANE_CALLS, mainCalls, shadowCalls, meshes: meshes.length, culledMeshes };
}

/** Preset cameras: the manifest spawn, and the Presidio overview (or, for a city without the Presidio, its far overview). */
function presets(manifest) {
  const spawn = { ...manifest.spawn, polar: DEFAULT_POLAR };
  const p = lonLatToBlock(PRESIDIO.lon, PRESIDIO.lat, manifest.proj);
  const [gx, gz] = manifest.chunks.grid;
  const [cx, cz] = chunkOf(Math.floor(p.x), Math.floor(p.z));
  const inGrid = cx >= 0 && cz >= 0 && cx < gx && cz < gz && manifest.chunks.list.some(([x, z]) => Math.abs(x - cx) <= 4 && Math.abs(z - cz) <= 4);
  const presidio = inGrid
    ? { x: p.x, z: p.z, dist: PRESIDIO.dist, az: manifest.spawn.az, polar: PRESIDIO.polar }
    : { x: manifest.spawn.x, z: manifest.spawn.z, dist: PRESIDIO.dist, az: manifest.spawn.az, polar: PRESIDIO.polar, note: "no Presidio in this city: far overview of the spawn" };
  const st = lonLatToBlock(STREET.lon, STREET.lat, manifest.proj);
  const [sx, sz] = chunkOf(Math.floor(st.x), Math.floor(st.z));
  const street = manifest.chunks.list.some(([x, z]) => x === sx && z === sz)
    ? { x: st.x, z: st.z, dist: STREET.dist, az: STREET.az, polar: STREET.polar, y: 1 }
    : { x: manifest.spawn.x, z: manifest.spawn.z, dist: STREET.dist, az: STREET.az, polar: STREET.polar, note: "no 2nd St in this city: street level at the spawn" };
  return { spawn, presidio, street };
}

/** → Promise<{lod0Ms, lod0Tris, lod1Ms, lod2Ms, frames: {spawn, presidio}, ok}> */
export async function perf({ city = "sf", gate = false } = {}) {
  const loaded = load(city);
  const { get } = loaded;
  const [cx, cz] = city === "fixture" ? [57, 25] : TARGET;
  const c = get(cx, cz);
  if (!c) throw new Error(`city:perf: ${city} has no chunk ${cx},${cz}`);
  const nb = { n: get(cx, cz - 1), s: get(cx, cz + 1), e: get(cx + 1, cz), w: get(cx - 1, cz) };
  const lod0 = time(() => meshChunk(c, nb, loaded.street.get(chunkKey(cx, cz)) ?? null));
  const lod0Tris = tris(lod0.out.opaque) + tris(lod0.out.walls) + tris(lod0.out.props) + tris(lod0.out.decals);
  const [rx, rz] = regionOf(cx, cz);
  const regionChunks = [];
  for (let z = rz * REGION; z < rz * REGION + REGION; z++) for (let x = rx * REGION; x < rx * REGION + REGION; x++) if (get(x, z)) regionChunks.push(get(x, z));
  const lod1 = time(() => meshRegion(regionChunks, [], 1));
  const lod2 = time(() => meshRegion(regionChunks, [], 2));
  console.log(`city:perf (${city})`);
  console.log(`  LOD0 chunk ${cx},${cz}: ${fmt(lod0)}, ${lod0Tris} triangles (opaque ${tris(lod0.out.opaque)}, walls ${tris(lod0.out.walls)}, props ${tris(lod0.out.props)}, decals ${tris(lod0.out.decals)}) — target ≤ ${TARGET_MS} ms: ${lod0.median <= TARGET_MS ? "ok" : "OVER"}`);
  console.log(`  LOD1 region ${rx},${rz} (${regionChunks.length} chunks): ${fmt(lod1)}, ${tris(lod1.out.opaque)} triangles`);
  console.log(`  LOD2 region ${rx},${rz}: ${fmt(lod2)}, ${tris(lod2.out.opaque)} triangles`);
  const frames = {};
  let ok = true;
  for (const [name, cam] of Object.entries(presets(loaded.manifest))) {
    const f = frameBudget(loaded, cam);
    const pass = f.triangles <= FRAME_BUDGET.triangles && f.calls <= FRAME_BUDGET.calls;
    ok &&= pass;
    frames[name] = f;
    console.log(`  frame ${name} @ ${Math.round(cam.x)},${Math.round(cam.z)} dist ${cam.dist}${cam.note ? ` (${cam.note})` : ""}: ${f.triangles} triangles, ${f.calls} draw calls`
      + ` (${f.mainCalls} main + ${f.shadowCalls} shadow; ${f.culledMeshes}/${f.meshes} meshes culled) — gate ≤ ${FRAME_BUDGET.triangles} / ≤ ${FRAME_BUDGET.calls}: ${pass ? "ok" : "OVER"}`);
  }
  if (gate && !ok) throw new Error(`city:perf (${city}): frame budget exceeded`);
  return { lod0Ms: lod0.median, lod0Tris, lod1Ms: lod1.median, lod2Ms: lod2.median, frames, ok };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--city");
  await perf({ city: i > 0 ? process.argv[i + 1] : "sf", gate: process.argv.includes("--gate") });
}
