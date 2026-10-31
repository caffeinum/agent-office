// The city scene: loads the manifest, streams chunks nearest-first, keeps LOD0 per-chunk meshes around the
// target (Chebyshev r ≤ 1) and one mesh per 4×4 region elsewhere (LOD1 within r ≤ 5, else LOD2), meshed in
// module workers and uploaded at most 2 per frame. Format v2 adds chunk props (one small mesh per LOD0 chunk),
// the unbuilt-land layer from landmask.bin (one mesh), the instanced landmarks.bin layer and a north arrow.
// Exposes the §3 scene API consumed by W6/W7, plus follow/unfollow and setCamera (spec-v2 §8 W4).

import { CHUNK, REGION, SURFACE, SURFACE_COLORS, chunkKey, chunkOf, pickId } from "../../shared/city.js";
import { grainTexture } from "../textures.js";
import { CAMERA as CAMERA_LIMITS, createStage } from "./stage.js";
import { createChunkStore, fail, loadLandmarks, loadLandmask, loadManifest } from "./loader.js";
import { pickRay } from "./pick.js";
import { createWindowAtlas } from "./textures.js";
import { createUnmapped } from "./unmapped.js";
import { createLandmarkLayer } from "./meshlayer.js";
import { mountCompass } from "./compass.js";

export const LOD0_R = 1;
export const LOD1_R = 5;
export const HYSTERESIS = 0.5;
export const UPLOADS_PER_FRAME = 2;
export const WORKERS = 2;
/** The camera keeps this many blocks of air above the heightfield under it (near plane is 1 block). */
export const CAMERA_CLEARANCE = 3;
/** Zoomed in, the orbit target rides up onto the roof under it: it stays within dist × this of the roof top. */
export const TARGET_ROOF_REACH = 0.5;
const WATER_MARGIN = 6000;
/** Default camera tilt (THREE Spherical phi) for spawn, ?at= and setCamera without polar. */
export const DEFAULT_POLAR = 0.95;
/** Follow: the target closes this share of the gap to the followed point per 1/60 s. */
export const FOLLOW_EASE = 0.2;

/** Chebyshev distance in chunks from a point (in chunk units) to the centre of chunk cx,cz. */
export const chunkDist = (tx, tz, cx, cz) => Math.max(Math.abs(tx - (cx + 0.5)), Math.abs(tz - (cz + 0.5)));

/** Integer Chebyshev distance in chunks from the target's chunk tcx,tcz to chunk cx,cz. */
export const chunkRing = (tcx, tcz, cx, cz) => Math.max(Math.abs(cx - tcx), Math.abs(cz - tcz));

/**
 * Ring membership with ±0.5 hysteresis: a chunk enters when its integer ring is ≤ R, and once inside it only
 * leaves when its centre is more than R + 0.5 + HYSTERESIS chunks from the target (half a chunk past the edge).
 */
export const withinRing = (ring, dist, R, inside) => (inside ? dist <= R + 0.5 + HYSTERESIS : ring <= R);

/** Lit-window share and pane area of the LOD0 atlas (textures.js): the region windows average out to the same glow. */
export const WINDOW_LIT = 0.38;
export const WINDOW_PANE = 0.35;
/** Sub-pixel windows glow at this share of the grid's mean, roughly what the mipmapped LOD0 atlas reads like after tone mapping. */
export const WINDOW_FAR = 0.45;

/**
 * Region meshes carry a per-vertex `glow` (255 on building walls). At night the emissive term on those walls is
 * a procedural window grid in world blocks (u = x + z along any axis-aligned wall, v = y), lit per cell by a hash,
 * so LOD1/LOD2 read like the LOD0 atlas; once a cell is smaller than a pixel it fades to a dimmed average.
 */
function glowEmissive(material) {
  material.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float glow;\nvarying float vGlow;\nvarying vec3 vWPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = glow;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
varying float vGlow;
varying vec3 vWPos;
float cityHash(vec2 c) { vec3 p = fract(vec3(c.xyx) * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
float cityWindows(vec3 w) {
  vec2 uv = vec2(w.x + w.z, w.y);
  vec2 f = fract(uv);
  float lit = step(cityHash(floor(uv)), ${WINDOW_LIT.toFixed(2)});
  float pane = step(0.19, f.x) * step(f.x, 0.81) * step(0.19, f.y) * step(f.y, 0.75);
  vec2 fw = fwidth(uv);
  return mix(lit * pane, ${(WINDOW_LIT * WINDOW_PANE * WINDOW_FAR).toFixed(3)}, smoothstep(0.35, 1.2, max(fw.x, fw.y)));
}`)
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlow * cityWindows(vWPos);");
  };
  return material;
}

/** Emissive for chunk props: a vertex `glow` (255 on light towers) lights the vertex colour at night. */
function propGlow(material) {
  material.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float glow;\nvarying float vGlow;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGlow = glow;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vGlow;")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlow * vColor.rgb;");
  };
  return material;
}

/**
 * → Promise<city> with the §3 API: manifest, store, setTheme, focus, onFrame, pick, worldToScreen, groundAt, buildingAt,
 * cameraDistance, add, remove, THREE, stats; v2: setCamera, getCamera, follow, unfollow, onUnfollow, attachCompass,
 * unmapped, landmarks, camera. opts.at = {x, z, dist, az?, polar?} overrides the manifest spawn.
 */
export async function createCityScene(container, { manifestUrl, theme = "day", at = null } = {}) {
  if (!manifestUrl) throw new Error("createCityScene: manifestUrl is required");
  const manifest = await loadManifest(manifestUrl);
  const baseUrl = new URL(".", new URL(manifestUrl, location.href)).href;
  const [mask, landmarkBoxes] = await Promise.all([loadLandmask(manifest, baseUrl), loadLandmarks(manifest, baseUrl)]);
  const unmapped = createUnmapped(manifest, mask);
  const store = createChunkStore(manifest, baseUrl);
  const stage = createStage(container, { theme });
  const { THREE, scene, camera, controls, renderer } = stage;

  const [minCx, minCz] = manifest.chunks.min;
  const [maxCx, maxCz] = manifest.chunks.max;
  const bbox = { x0: minCx * CHUNK, z0: minCz * CHUNK, x1: (maxCx + 1) * CHUNK, z1: (maxCz + 1) * CHUNK };
  const listed = manifest.chunks.list.map(([cx, cz]) => [cx, cz]);

  /* ── materials ──────────────────────────────────────────────────────────────────────────────── */
  const grain = grainTexture();
  const atlas = createWindowAtlas();
  const mats = {
    opaque: new THREE.MeshStandardMaterial({ vertexColors: true, map: grain, roughness: 0.9, metalness: 0, flatShading: true }),
    walls: new THREE.MeshStandardMaterial({
      vertexColors: true, map: atlas.map, emissiveMap: atlas.emissiveMap, emissive: new THREE.Color("#ffd9a0"), emissiveIntensity: 0,
      roughness: 0.8, metalness: 0, flatShading: true,
    }),
    region: glowEmissive(new THREE.MeshStandardMaterial({
      vertexColors: true, emissive: new THREE.Color("#ffd9a0"), emissiveIntensity: 0, roughness: 0.92, metalness: 0, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
    })),
    water: new THREE.MeshStandardMaterial({ color: SURFACE_COLORS[SURFACE.WATER], roughness: 0.35, metalness: 0, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 8 }),
    props: propGlow(new THREE.MeshStandardMaterial({ vertexColors: true, emissive: new THREE.Color("#ffffff"), emissiveIntensity: 0, roughness: 0.6, metalness: 0.2, flatShading: true })),
    unbuilt: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 }),
  };
  const landmarks = createLandmarkLayer(THREE, landmarkBoxes);
  scene.add(landmarks.group);
  stage.onTheme((name, th) => {
    mats.walls.emissiveIntensity = th.windows * 1.6;
    mats.region.emissiveIntensity = th.windows * 1.6 * 0.6;
    mats.props.emissiveIntensity = th.windows * 1.5;
    landmarks.setNight(th.windows);
  });
  stage.setTheme(theme);

  // one water plane at sea level under everything: absent (all-water) chunks and the bay beyond the bbox
  const waterGeo = new THREE.PlaneGeometry(bbox.x1 - bbox.x0 + WATER_MARGIN * 2, bbox.z1 - bbox.z0 + WATER_MARGIN * 2);
  const water = new THREE.Mesh(waterGeo, mats.water);
  water.rotation.x = -Math.PI / 2;
  water.position.set((bbox.x0 + bbox.x1) / 2, -0.05, (bbox.z0 + bbox.z1) / 2);
  water.receiveShadow = true;
  scene.add(water);

  /* ── meshing workers ────────────────────────────────────────────────────────────────────────── */
  const workers = [];
  const waiting = new Map();
  let nextId = 1;
  for (let i = 0; i < WORKERS; i++) {
    const w = new Worker(new URL("./mesher.worker.js", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      const job = waiting.get(e.data.id);
      if (!job) throw fail(new Error(`mesher replied to unknown request ${e.data.id}`));
      waiting.delete(e.data.id);
      if (e.data.error) job.reject(new Error(`mesher (${job.what}): ${e.data.error}`));
      else job.resolve(e.data);
    };
    w.onerror = (e) => { throw fail(new Error(`mesher worker crashed: ${e.message || "failed to load mesher.worker.js"}`)); };
    workers.push(w);
  }
  function mesh(req, what) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, what });
      workers[id % workers.length].postMessage({ ...req, id });
    });
  }

  const uploads = [];
  function buildMesh(buf, material, what) {
    if (!buf || !buf.positions || !buf.indices || !buf.colors || !buf.origin) throw new Error(`${what}: mesher reply is missing positions/colors/indices/origin`);
    if (!buf.indices.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(buf.positions, 3));
    g.setAttribute("color", new THREE.BufferAttribute(buf.colors, 3, true));
    if (buf.normals) g.setAttribute("normal", new THREE.BufferAttribute(buf.normals, 3, true));
    if (buf.uvs) g.setAttribute("uv", new THREE.BufferAttribute(buf.uvs, 2));
    if (material === mats.region || material === mats.props) {
      if (!buf.glow) throw new Error(`${what}: mesh is missing the glow attribute`);
      g.setAttribute("glow", new THREE.BufferAttribute(buf.glow, 1, true));
    }
    g.setIndex(new THREE.BufferAttribute(buf.indices, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, material);
    m.position.set(buf.origin[0], buf.origin[1], buf.origin[2]);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    return m;
  }
  const disposeMesh = (m) => { if (m) { scene.remove(m); m.geometry.dispose(); } };

  /* ── LOD bookkeeping ────────────────────────────────────────────────────────────────────────── */
  // lod0: key → {cx, cz, want, inflight, meshes: [opaque, walls] | null}
  const lod0 = new Map();
  // regions: key → {rx, rz, chunks: [[cx, cz]], lod, inflight, shown: {lod, skip: Set} | null, mesh}
  const regions = new Map();
  for (const [cx, cz] of listed) {
    const rx = Math.floor(cx / REGION), rz = Math.floor(cz / REGION);
    const key = `${rx}_${rz}`;
    if (!regions.has(key)) regions.set(key, { key, rx, rz, chunks: [], lod: 0, inflight: false, shown: null, mesh: null });
    regions.get(key).chunks.push([cx, cz]);
  }

  const ready = (cx, cz) => { const s = store.status(cx, cz); return s === "loaded" || s === "absent"; };
  /** meshChunk neighbour: a listed chunk, unbuilt land ({unbuilt} edge heights) or null (sea / water chunk). */
  const neighbour = (cx, cz, side) => (store.status(cx, cz) === "absent" ? unmapped.neighbour(cx, cz, side) : store.get(cx, cz) ?? null);

  function requestLod0(e) {
    e.inflight = true;
    const chunk = store.get(e.cx, e.cz);
    mesh({ kind: "chunk", lod: 0, chunk, n: neighbour(e.cx, e.cz - 1, "n"), s: neighbour(e.cx, e.cz + 1, "s"), e: neighbour(e.cx + 1, e.cz, "e"), w: neighbour(e.cx - 1, e.cz, "w") }, `chunk ${e.cx},${e.cz}`)
      .then((reply) => uploads.push(() => {
        e.inflight = false;
        if (!e.want) return;
        const what = `chunk ${e.cx},${e.cz}`;
        const meshes = [buildMesh(reply.opaque, mats.opaque, what), buildMesh(reply.walls, mats.walls, what), buildMesh(reply.props, mats.props, what)].filter(Boolean);
        for (const m of meshes) { m.castShadow = true; m.receiveShadow = true; scene.add(m); }
        e.meshes = meshes;
        dirty = true;
      }))
      .catch((err) => { throw fail(err); });
  }

  function requestRegion(r, lod, skip) {
    r.inflight = true;
    const chunks = r.chunks.filter(([cx, cz]) => !skip.has(chunkKey(cx, cz))).map(([cx, cz]) => store.get(cx, cz));
    const skipList = [...skip].map((k) => k.split("_").map(Number));
    const what = `region ${r.key} lod ${lod}`;
    const done = (m) => uploads.push(() => {
      r.inflight = false;
      disposeMesh(r.mesh);
      r.mesh = m();
      if (r.mesh) { r.mesh.receiveShadow = lod === 1; scene.add(r.mesh); }
      r.shown = { lod, skip };
      dirty = true;
    });
    if (!chunks.length) { done(() => null); return; }
    mesh({ kind: "region", lod, chunks, skip: skipList }, what)
      .then((reply) => done(() => buildMesh(reply.opaque, mats.region, what)))
      .catch((err) => { throw fail(err); });
  }

  // the unbuilt-land layer: one mesh for the whole grid, meshed once
  let unbuiltMesh = null;
  mesh({ kind: "unbuilt", mask, listed: manifest.chunks.list.map(([cx, cz]) => [cx, cz]), water: manifest.water }, "unbuilt land")
    .then((reply) => uploads.push(() => {
      unbuiltMesh = buildMesh(reply.opaque, mats.unbuilt, "unbuilt land");
      if (unbuiltMesh) { unbuiltMesh.receiveShadow = true; unbuiltMesh.name = "city-unbuilt"; scene.add(unbuiltMesh); }
      dirty = true;
    }))
    .catch((err) => { throw fail(err); });

  let dirty = true;
  let lastTarget = { x: NaN, z: NaN };
  store.onLoad(() => { dirty = true; });

  function updateLod() {
    const t = controls.target;
    const tx = t.x / CHUNK, tz = t.z / CHUNK;
    const [tcx, tcz] = chunkOf(Math.floor(t.x), Math.floor(t.z));
    // load order: nearest first
    for (const [cx, cz] of listed) if (store.status(cx, cz) === "unknown" || store.status(cx, cz) === "pending") store.request(cx, cz, chunkDist(tx, tz, cx, cz));

    for (const [cx, cz] of listed) {
      const key = chunkKey(cx, cz);
      let e = lod0.get(key);
      const want = withinRing(chunkRing(tcx, tcz, cx, cz), chunkDist(tx, tz, cx, cz), LOD0_R, !!e?.want);
      if (!e && !want) continue;
      if (!e) { e = { cx, cz, want, inflight: false, meshes: null }; lod0.set(key, e); }
      e.want = want;
      if (want && !e.meshes && !e.inflight && store.status(cx, cz) === "loaded"
        && ready(cx, cz - 1) && ready(cx, cz + 1) && ready(cx + 1, cz) && ready(cx - 1, cz)) requestLod0(e);
    }

    for (const r of regions.values()) {
      if (r.inflight) continue;
      if (!r.chunks.every(([cx, cz]) => store.status(cx, cz) === "loaded")) continue;
      let ring = Infinity, near = Infinity;
      for (const [cx, cz] of r.chunks) { ring = Math.min(ring, chunkRing(tcx, tcz, cx, cz)); near = Math.min(near, chunkDist(tx, tz, cx, cz)); }
      const lod = withinRing(ring, near, LOD1_R, r.shown?.lod === 1) ? 1 : 2;
      const skip = new Set();
      for (const [cx, cz] of r.chunks) { const e = lod0.get(chunkKey(cx, cz)); if (e?.want && e.meshes) skip.add(chunkKey(cx, cz)); }
      const same = r.shown && r.shown.lod === lod && r.shown.skip.size === skip.size && [...skip].every((k) => r.shown.skip.has(k));
      if (!same) requestRegion(r, lod, skip);
    }

    // an unwanted LOD0 chunk goes once its region draws it again (or right away when nothing will)
    for (const [key, e] of lod0) {
      if (e.want) continue;
      if (e.meshes) {
        const r = regions.get(`${Math.floor(e.cx / REGION)}_${Math.floor(e.cz / REGION)}`);
        if (r.shown && !r.shown.skip.has(key)) { for (const m of e.meshes) disposeMesh(m); e.meshes = null; }
      }
      if (!e.meshes && !e.inflight) lod0.delete(key);
    }
  }

  /* ── ground queries ─────────────────────────────────────────────────────────────────────────── */
  function column(x, z) {
    const bx = Math.floor(x), bz = Math.floor(z);
    const [cx, cz] = chunkOf(bx, bz);
    const chunk = store.get(cx, cz);
    if (!chunk) return null;
    return { chunk, i: (bz - cz * CHUNK) * CHUNK + (bx - cx * CHUNK) };
  }
  /** Ground y under a block position (a building column's ground is its base); unbuilt land's coarse height; 0 on water or unloaded chunks. */
  function groundAt(x, z) {
    const c = column(x, z);
    if (c) return c.chunk.ground[c.i];
    return unmapped.heightAt(x, z) ?? 0;
  }
  /** Highest solid y of the column under a block position: column top, deck slab, prop or ground; 0 on water / unloaded. */
  function surfaceTop(x, z) {
    const c = column(x, z);
    if (!c) return unmapped.heightAt(x, z) ?? 0;
    const k = c.i;
    let top = c.chunk.bldg[k] ? c.chunk.top[k] : Math.max(c.chunk.ground[k], Math.abs(c.chunk.deck[k]));
    for (const p of c.chunk.props) if (p.lz * CHUNK + p.lx === k && p.y1 > top) top = p.y1;
    return top;
  }
  /** Highest surfaceTop over the (2r+1)² columns around a block position. */
  function surfaceTopNear(x, z, r) {
    let top = 0;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) top = Math.max(top, surfaceTop(x + dx, z + dz));
    return top;
  }
  /** → {id (parent || id: what pick returns), entryId, parent, base, top (entry max), columnTop} | null */
  function buildingAt(x, z) {
    const c = column(x, z);
    if (!c) return null;
    const b = c.chunk.bldg[c.i];
    if (!b) return null;
    const e = c.chunk.buildings[b - 1];
    return { id: pickId(e), entryId: e.id, parent: e.parent, base: e.base, top: e.top, columnTop: c.chunk.top[c.i] };
  }

  /* ── camera ─────────────────────────────────────────────────────────────────────────────────── */
  const camAnim = { active: false };
  const offsetDir = new THREE.Vector3();

  /* ── follow ─────────────────────────────────────────────────────────────────────────────────── */
  let following = null;
  const unfollowCbs = [];
  /** Track getPos() → {x, y, z} every frame (the target eases onto it, the camera keeps its offset). */
  function follow(getPos) {
    if (typeof getPos !== "function") throw new Error("city.follow: getPos must be a function → {x, y, z}");
    camAnim.active = false;
    following = getPos;
  }
  function unfollow(reason) {
    if (!following) return;
    following = null;
    for (const fn of unfollowCbs) fn(reason);
  }
  function stepFollow(dt) {
    if (!following) return;
    const p = following();
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) throw new Error(`city.follow: getPos returned ${JSON.stringify(p)}, expected {x, y, z}`);
    const k = 1 - Math.pow(1 - FOLLOW_EASE, dt * 60);
    const t = controls.target;
    const dx = (p.x - t.x) * k, dy = (p.y - t.y) * k, dz = (p.z - t.z) * k;
    t.x += dx; t.y += dy; t.z += dz;
    camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
  }

  /**
   * Put the camera on (x, z) at distance dist, azimuth az (THREE Spherical theta) and tilt polar (phi). Instant;
   * cancels a fly-to and follow. dist and polar are clamped to the stage's camera limits.
   */
  function setCamera({ x, z, dist, az = manifest.spawn.az, polar = DEFAULT_POLAR }) {
    for (const [k, v] of Object.entries({ x, z, dist, az, polar })) if (!Number.isFinite(v)) throw new Error(`city.setCamera: ${k} must be a finite number, got ${v}`);
    if (!(dist > 0)) throw new Error(`city.setCamera: dist must be > 0, got ${dist}`);
    camAnim.active = false;
    unfollow("api");
    const d = THREE.MathUtils.clamp(dist, CAMERA_LIMITS.minDist, CAMERA_LIMITS.maxDist);
    const phi = THREE.MathUtils.clamp(polar, CAMERA_LIMITS.minPolar, CAMERA_LIMITS.maxPolar);
    offsetDir.setFromSphericalCoords(1, phi, az);
    controls.target.set(x, groundAt(x, z), z);
    camera.position.copy(controls.target).addScaledVector(offsetDir, d);
    camera.lookAt(controls.target);
    controls.update();
  }
  const sph = new THREE.Spherical();
  const offsetNow = new THREE.Vector3();
  /** → {x, z, dist, az, polar} of the orbit camera now (the ?cam= state). */
  function getCamera() {
    sph.setFromVector3(offsetNow.copy(camera.position).sub(controls.target));
    return { x: controls.target.x, z: controls.target.z, dist: sph.radius, az: sph.theta, polar: sph.phi };
  }

  setCamera(at ?? manifest.spawn);

  const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  function focus(x, z, dist) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error(`city.focus: bad point ${x},${z}`);
    const d = dist ?? camera.position.distanceTo(controls.target);
    if (!(d > 0)) throw new Error(`city.focus: bad distance ${dist}`);
    const toT = new THREE.Vector3(x, groundAt(x, z), z);
    const off = camera.position.clone().sub(controls.target).setLength(THREE.MathUtils.clamp(d, controls.minDistance, controls.maxDistance));
    Object.assign(camAnim, { active: true, t0: performance.now(), dur: 900, fromT: controls.target.clone(), toT, fromP: camera.position.clone(), toP: toT.clone().add(off) });
  }
  controls.addEventListener("start", () => { camAnim.active = false; unfollow("user"); });

  function stepCamera(now, dt, keyed) {
    if (keyed) { camAnim.active = false; unfollow("user"); }
    stepFollow(dt);
    if (camAnim.active) {
      const k = Math.min(1, (now - camAnim.t0) / camAnim.dur), e = easeInOut(k);
      controls.target.lerpVectors(camAnim.fromT, camAnim.toT, e);
      camera.position.lerpVectors(camAnim.fromP, camAnim.toP, e);
      camera.lookAt(controls.target);
      if (k >= 1) camAnim.active = false;
    }
    // clamp the target to the city and glide its height over the terrain; close in, lift it toward the roof
    // under it so orbiting a tower pivots on the tower, not on a point buried in it
    const t = controls.target;
    const cx = THREE.MathUtils.clamp(t.x, bbox.x0, bbox.x1), cz = THREE.MathUtils.clamp(t.z, bbox.z0, bbox.z1);
    const gy = Math.max(groundAt(cx, cz), surfaceTop(cx, cz) - camera.position.distanceTo(t) * TARGET_ROOF_REACH);
    const cy = camAnim.active || following ? t.y : t.y + (gy - t.y) * Math.min(1, dt * 4);
    if (cx !== t.x || cz !== t.z || cy !== t.y) {
      const dx = cx - t.x, dy = cy - t.y, dz = cz - t.z;
      t.set(cx, cy, cz);
      camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
    }
    // never inside a building: the camera stays CAMERA_CLEARANCE above the heightfield around it
    const floor = surfaceTopNear(camera.position.x, camera.position.z, 1) + CAMERA_CLEARANCE;
    if (camera.position.y < floor) {
      camera.position.y = floor;
      camera.lookAt(t);
    }
    const dist = camera.position.distanceTo(t);
    scene.fog.near = Math.min(dist * 1.5, camera.far);
    scene.fog.far = Math.min(dist * 4.5, camera.far);
  }

  /* ── compass ────────────────────────────────────────────────────────────────────────────────── */
  let compass = null;
  /** Draw the north arrow into `el` (W7's #city-compass); done automatically when it exists and rotDeg ≠ 0. */
  function attachCompass(el) {
    if (compass) compass.destroy();
    compass = mountCompass(el, manifest.proj);
    return compass;
  }
  const compassEl = document.getElementById("city-compass");
  if (compassEl && manifest.proj.rotDeg !== 0) attachCompass(compassEl);

  /* ── frame ──────────────────────────────────────────────────────────────────────────────────── */
  const frameCbs = [];
  stage.onFrame((now, dt, keyed) => {
    stepCamera(now, dt, keyed);
    if (compass) compass.update(controls.getAzimuthalAngle());
    const t = controls.target;
    if (Math.abs(t.x - lastTarget.x) > 2 || Math.abs(t.z - lastTarget.z) > 2) { dirty = true; lastTarget = { x: t.x, z: t.z }; }
    if (dirty) { dirty = false; updateLod(); }
    for (let i = 0; i < UPLOADS_PER_FRAME && uploads.length; i++) uploads.shift()();
    for (const fn of frameCbs) fn(now);
  });

  /* ── picking and projection ─────────────────────────────────────────────────────────────────── */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  function pick(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const { origin, direction } = raycaster.ray;
    return pickRay(store, { x: origin.x, y: origin.y, z: origin.z }, { x: direction.x, y: direction.y, z: direction.z }, camera.far, { unbuiltAt: unmapped.heightAt });
  }
  const proj = new THREE.Vector3();
  function worldToScreen(x, y, z) {
    proj.set(x, y, z).project(camera);
    const { w, h } = stage.size;
    return { x: (proj.x * 0.5 + 0.5) * w, y: (-proj.y * 0.5 + 0.5) * h, visible: proj.z > -1 && proj.z < 1 && Math.abs(proj.x) <= 1 && Math.abs(proj.y) <= 1 };
  }

  // a tap / click that barely moved is a pick, run only when someone listens (the UI picks on its own)
  const tapCbs = [];
  let down = null;
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", (e) => { down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null; });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || down.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), long = performance.now() - down.t > 600;
    down = null;
    if (moved > 6 || long || e.button !== 0 || !tapCbs.length) return;
    const hit = pick(e.clientX, e.clientY);
    for (const fn of tapCbs) fn({ clientX: e.clientX, clientY: e.clientY, hit });
  });

  const counts = () => {
    let l0 = 0, r1 = 0, r2 = 0;
    for (const e of lod0.values()) if (e.meshes) l0++;
    for (const r of regions.values()) if (r.mesh) { if (r.shown.lod === 1) r1++; else r2++; }
    return { lod0: l0, regions1: r1, regions2: r2, pending: store.pending() + waiting.size + uploads.length, unbuilt: unbuiltMesh !== null, landmarks: landmarks.count };
  };

  const city = {
    manifest,
    store,
    THREE,
    stage,
    canvas,
    setTheme: (name) => stage.setTheme(name),
    get theme() { return stage.theme; },
    focus,
    setCamera,
    getCamera,
    follow,
    unfollow: () => unfollow("api"),
    /** fn(reason: "user" | "api") when follow ends (a pan, orbit, key or setCamera cancels it). */
    onUnfollow(fn) { unfollowCbs.push(fn); },
    get following() { return following !== null; },
    attachCompass,
    unmapped,
    landmarks,
    camera,
    onFrame(fn) { frameCbs.push(fn); },
    /** fn({clientX, clientY, hit}) on a click / tap that barely moved; hit is pick()'s result. */
    onTap(fn) { tapCbs.push(fn); },
    pick,
    worldToScreen,
    groundAt,
    buildingAt,
    cameraDistance: () => camera.position.distanceTo(controls.target),
    target: () => ({ x: controls.target.x, y: controls.target.y, z: controls.target.z }),
    add: (o) => scene.add(o),
    remove: (o) => scene.remove(o),
    stats: () => ({ ...stage.stats(), chunks: counts() }),
    dispose() {
      for (const w of workers) w.terminate();
      stage.dispose();
    },
  };
  window.__city = city;
  return city;
}
