// The city scene: loads the manifest, streams chunks nearest-first, keeps LOD0 per-chunk meshes around the
// target (Chebyshev r ≤ 1) and one mesh per 4×4 region elsewhere (LOD1 within r ≤ 5, else LOD2), meshed in
// module workers and uploaded at most 2 per frame. Exposes the §3 scene API consumed by W6.

import { CHUNK, REGION, SURFACE, SURFACE_COLORS, chunkKey, chunkOf } from "../../shared/city.js";
import { grainTexture } from "../textures.js";
import { createStage } from "./stage.js";
import { createChunkStore, fail, loadManifest } from "./loader.js";
import { pickRay } from "./pick.js";
import { createWindowAtlas } from "./textures.js";

export const LOD0_R = 1;
export const LOD1_R = 5;
export const HYSTERESIS = 0.5;
export const UPLOADS_PER_FRAME = 2;
export const WORKERS = 2;
const WATER_MARGIN = 6000;

/** Chebyshev distance in chunks from a point (in chunk units) to the centre of chunk cx,cz. */
export const chunkDist = (tx, tz, cx, cz) => Math.max(Math.abs(tx - (cx + 0.5)), Math.abs(tz - (cz + 0.5)));

/** Integer Chebyshev distance in chunks from the target's chunk tcx,tcz to chunk cx,cz. */
export const chunkRing = (tcx, tcz, cx, cz) => Math.max(Math.abs(cx - tcx), Math.abs(cz - tcz));

/**
 * Ring membership with ±0.5 hysteresis: a chunk enters when its integer ring is ≤ R, and once inside it only
 * leaves when its centre is more than R + 0.5 + HYSTERESIS chunks from the target (half a chunk past the edge).
 */
export const withinRing = (ring, dist, R, inside) => (inside ? dist <= R + 0.5 + HYSTERESIS : ring <= R);

/** Vertex colours come from the hex palette, so they are sRGB bytes: linearise them in the shader. */
function srgbVertexColors(material) {
  material.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("#include <color_vertex>", "#include <color_vertex>\n#ifdef USE_COLOR\n  vColor.rgb = pow(vColor.rgb, vec3(2.2));\n#endif");
  };
  return material;
}

/** → Promise<city> with the §3 API: manifest, store, setTheme, focus, onFrame, pick, worldToScreen, groundAt, buildingAt, cameraDistance, add, remove, THREE, stats */
export async function createCityScene(container, { manifestUrl, theme = "day", at = null } = {}) {
  if (!manifestUrl) throw new Error("createCityScene: manifestUrl is required");
  const manifest = await loadManifest(manifestUrl);
  const baseUrl = new URL(".", new URL(manifestUrl, location.href)).href;
  const store = createChunkStore(manifest, baseUrl);
  const stage = createStage(container, { theme });
  const { THREE, scene, camera, controls, renderer } = stage;

  const [minCx, minCz] = manifest.chunks.min;
  const [maxCx, maxCz] = manifest.chunks.max;
  const bbox = { x0: minCx * CHUNK, z0: minCz * CHUNK, x1: (maxCx + 1) * CHUNK, z1: (maxCz + 1) * CHUNK };
  const listed = manifest.chunks.list.map(([cx, cz]) => [cx, cz]);
  const inBounds = (cx, cz) => cx >= minCx && cx <= maxCx && cz >= minCz && cz <= maxCz;

  /* ── materials ──────────────────────────────────────────────────────────────────────────────── */
  const grain = grainTexture();
  const atlas = createWindowAtlas();
  for (const t of [atlas.map, atlas.emissiveMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1 / 8, 1 / 8);
  }
  const mats = {
    opaque: srgbVertexColors(new THREE.MeshStandardMaterial({ vertexColors: true, map: grain, roughness: 0.9, metalness: 0, flatShading: true })),
    walls: srgbVertexColors(new THREE.MeshStandardMaterial({
      vertexColors: true, map: atlas.map, emissiveMap: atlas.emissiveMap, emissive: new THREE.Color("#ffd9a0"), emissiveIntensity: 0,
      roughness: 0.8, metalness: 0, flatShading: true,
    })),
    region: srgbVertexColors(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2,
    })),
    water: new THREE.MeshStandardMaterial({ color: SURFACE_COLORS[SURFACE.WATER], roughness: 0.35, metalness: 0, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 8 }),
  };
  stage.onTheme((name, th) => {
    mats.walls.emissiveIntensity = th.windows * 1.6;
    mats.region.emissive.set(name === "night" ? "#1a1626" : "#000000");
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
    if (buf.uvs) g.setAttribute("uv", new THREE.BufferAttribute(buf.uvs, 2));
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
  const neighbour = (cx, cz) => (inBounds(cx, cz) ? store.get(cx, cz) ?? null : null);

  function requestLod0(e) {
    e.inflight = true;
    const chunk = store.get(e.cx, e.cz);
    mesh({ kind: "chunk", lod: 0, chunk, n: neighbour(e.cx, e.cz - 1), s: neighbour(e.cx, e.cz + 1), e: neighbour(e.cx + 1, e.cz), w: neighbour(e.cx - 1, e.cz) }, `chunk ${e.cx},${e.cz}`)
      .then((reply) => uploads.push(() => {
        e.inflight = false;
        if (!e.want) return;
        const what = `chunk ${e.cx},${e.cz}`;
        const meshes = [buildMesh(reply.opaque, mats.opaque, what), buildMesh(reply.walls, mats.walls, what)].filter(Boolean);
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
  /** Ground y under a block position (a building column's ground is its base); 0 on water or unloaded chunks. */
  function groundAt(x, z) {
    const c = column(x, z);
    return c ? c.chunk.ground[c.i] : 0;
  }
  function buildingAt(x, z) {
    const c = column(x, z);
    if (!c) return null;
    const b = c.chunk.bldg[c.i];
    if (!b) return null;
    const { id, base, top } = c.chunk.buildings[b - 1];
    return { id, base, top };
  }

  /* ── camera ─────────────────────────────────────────────────────────────────────────────────── */
  const spawn = at ?? manifest.spawn;
  const camAnim = { active: false };
  const offsetDir = new THREE.Vector3().setFromSphericalCoords(1, 0.95, Math.PI * 0.18);
  function place(x, z, dist) {
    const y = groundAt(x, z);
    controls.target.set(x, y, z);
    camera.position.copy(controls.target).addScaledVector(offsetDir, dist);
    camera.lookAt(controls.target);
    controls.update();
  }
  place(spawn.x, spawn.z, spawn.dist);

  const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
  function focus(x, z, dist) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error(`city.focus: bad point ${x},${z}`);
    const d = dist ?? camera.position.distanceTo(controls.target);
    if (!(d > 0)) throw new Error(`city.focus: bad distance ${dist}`);
    const toT = new THREE.Vector3(x, groundAt(x, z), z);
    const off = camera.position.clone().sub(controls.target).setLength(THREE.MathUtils.clamp(d, controls.minDistance, controls.maxDistance));
    Object.assign(camAnim, { active: true, t0: performance.now(), dur: 900, fromT: controls.target.clone(), toT, fromP: camera.position.clone(), toP: toT.clone().add(off) });
  }
  controls.addEventListener("start", () => { camAnim.active = false; });

  function stepCamera(now, dt, keyed) {
    if (keyed) camAnim.active = false;
    if (camAnim.active) {
      const k = Math.min(1, (now - camAnim.t0) / camAnim.dur), e = easeInOut(k);
      controls.target.lerpVectors(camAnim.fromT, camAnim.toT, e);
      camera.position.lerpVectors(camAnim.fromP, camAnim.toP, e);
      camera.lookAt(controls.target);
      if (k >= 1) camAnim.active = false;
    }
    // clamp the target to the city and glide its height over the terrain
    const t = controls.target;
    const cx = THREE.MathUtils.clamp(t.x, bbox.x0, bbox.x1), cz = THREE.MathUtils.clamp(t.z, bbox.z0, bbox.z1);
    const gy = groundAt(cx, cz);
    const cy = camAnim.active ? t.y : t.y + (gy - t.y) * Math.min(1, dt * 4);
    if (cx !== t.x || cz !== t.z || cy !== t.y) {
      const dx = cx - t.x, dy = cy - t.y, dz = cz - t.z;
      t.set(cx, cy, cz);
      camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
    }
    const dist = camera.position.distanceTo(t);
    scene.fog.near = Math.min(dist * 1.5, camera.far);
    scene.fog.far = Math.min(dist * 4.5, camera.far);
  }

  /* ── frame ──────────────────────────────────────────────────────────────────────────────────── */
  const frameCbs = [];
  stage.onFrame((now, dt, keyed) => {
    stepCamera(now, dt, keyed);
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
    return pickRay(store, { x: origin.x, y: origin.y, z: origin.z }, { x: direction.x, y: direction.y, z: direction.z }, camera.far);
  }
  const proj = new THREE.Vector3();
  function worldToScreen(x, y, z) {
    proj.set(x, y, z).project(camera);
    const { w, h } = stage.size;
    return { x: (proj.x * 0.5 + 0.5) * w, y: (-proj.y * 0.5 + 0.5) * h, visible: proj.z > -1 && proj.z < 1 && Math.abs(proj.x) <= 1 && Math.abs(proj.y) <= 1 };
  }

  // a tap / click that barely moved is a pick
  const tapCbs = [];
  let down = null;
  const canvas = renderer.domElement;
  canvas.addEventListener("pointerdown", (e) => { down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null; });
  canvas.addEventListener("pointerup", (e) => {
    if (!down || down.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), long = performance.now() - down.t > 600;
    down = null;
    if (moved > 6 || long || e.button !== 0) return;
    const hit = pick(e.clientX, e.clientY);
    for (const fn of tapCbs) fn({ clientX: e.clientX, clientY: e.clientY, hit });
  });

  const counts = () => {
    let l0 = 0, r1 = 0, r2 = 0;
    for (const e of lod0.values()) if (e.meshes) l0++;
    for (const r of regions.values()) if (r.mesh) { if (r.shown.lod === 1) r1++; else r2++; }
    return { lod0: l0, regions1: r1, regions2: r2, pending: store.pending() + waiting.size + uploads.length };
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
