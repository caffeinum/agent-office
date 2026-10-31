// The 3D office: renderer + shader-pack-ish look (warm sun with soft shadows, hemisphere fill, baked
// voxel AO, light fog, bloom on screens and lamps at night), mouse orbit, instanced furniture with pop
// animations, voxel characters walking A* routes to desks and lounge spots, picking, and the edit ghost.
// Pure decisions live in model.js; this file only turns them into pixels.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { footprint, kindOf } from "../shared/catalog.js";
import { DEFAULT_THEME } from "../shared/theme.js";
import {
  SEATED, assignSpots, blockedCells, deskSeating, entryPoint, hashStr, idleSpots, kindGeometryPlan, layoutBatches, limbAngles, poseFor,
  route, seatOf, themeLook, usableSpots,
} from "./model.js";
import { MODELS, SEAT_Y, WALL_H } from "./furniture.js";
import { buildGeometry, vbox } from "./voxel.js";
import { CROWN, applyLimbs, applyProps, awayMaterial, baseMaterial, blink, buildCharacter } from "./character.js";
import * as T from "./textures.js";

const WALK_SPEED = 1.7;
const POP_MS = 420;
const BORDER = 2.5;
const FADE_MS = 900;
const THEMES = {
  day: { hemiSky: "#d7ecff", hemiGround: "#e3c39d", hemi: 1.25, sun: 2.7, sunColor: "#ffe4bd", fog: "#e8eef2", bloom: 0.28, threshold: 0.92, glow: 1.0, lamp: 0.95, point: 0, exposure: 1.0 },
  night: { hemiSky: "#41508f", hemiGround: "#2b2236", hemi: 0.5, sun: 0.35, sunColor: "#9fb3ff", fog: "#1d2147", bloom: 0.7, threshold: 0.72, glow: 1.2, lamp: 2.4, point: 9, exposure: 1.05 },
};

const easeOutBack = (t) => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export function createScene(container, { fetchAsset = (url) => fetch(url), onError = (msg) => console.error(msg) } = {}) {
  const probe = document.createElement("canvas");
  if (!probe.getContext("webgl2")) throw new Error("this browser has no WebGL2 (disabled, or no GPU) — the office needs it.");

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.32;
  controls.maxPolarAngle = 1.2;
  controls.minDistance = 7;
  controls.maxDistance = 70;
  controls.screenSpacePanning = false;
  controls.zoomSpeed = 0.9;
  controls.rotateSpeed = 0.6;
  // map-style: drag moves the camera, right-drag (or shift/ctrl/⌘ + drag) orbits; touch: one finger moves, two zoom + orbit
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.3, 0.55, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const hemi = new THREE.HemisphereLight("#d7ecff", "#e3c39d", 1.2);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight("#ffe4bd", 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  sun.shadow.radius = 5;
  sun.shadow.blurSamples = 12;
  scene.add(sun, sun.target);
  scene.fog = new THREE.Fog("#e8eef2", 30, 120);

  const tex = {
    grain: T.grainTexture(), wood: T.woodTexture(), plaster: T.plasterTexture(), grass: T.grassTexture(), plinth: T.plinthTexture(),
    rug: T.rugTexture(), screen: T.screenTexture(), tv: T.tvTexture(), rack: T.rackTexture(),
    windowDay: T.windowTexture(false), skyDay: T.skyTexture(false), skyNight: T.skyTexture(true), blob: T.blobTexture(),
  };
  const texCache = new Map();
  const cachedTex = (key, make) => { if (!texCache.has(key)) texCache.set(key, make()); return texCache.get(key); };
  const floorTex = (m) => cachedTex(`floor:${m}`, () => T.floorTexture(m));
  const wallTex = (m) => cachedTex(`wall:${m}`, () => T.wallTexture(m));
  const nightWindowTex = (style) => cachedTex(`night:${style}`, () => T.nightWindowTexture(style));

  /** A standard material whose map crossfades: shows mix(map, map2, uMix). */
  function fadeMaterial(opts) {
    const m = new THREE.MeshStandardMaterial(opts);
    const u = { map2: { value: opts.map }, uMix: { value: 0 } };
    m.userData.xfade = u;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.map2 = u.map2;
      sh.uniforms.uMix = u.uMix;
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <map_pars_fragment>", "#include <map_pars_fragment>\nuniform sampler2D map2;\nuniform float uMix;")
        .replace("#include <map_fragment>", "#ifdef USE_MAP\n  diffuseColor *= mix(texture2D(map, vMapUv), texture2D(map2, vMapUv), uMix);\n#endif");
    };
    return m;
  }
  const mats = {
    base: new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.grain, roughness: 0.86, metalness: 0 }),
    accent: new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.grain, roughness: 0.82, metalness: 0 }),
    rug: new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.rug, roughness: 1 }),
    ghost: new THREE.MeshBasicMaterial({ color: "#7dffb0", transparent: true, opacity: 0.45, depthWrite: false }),
    blob: new THREE.MeshBasicMaterial({ map: tex.blob, transparent: true, depthWrite: false }),
    outline: new THREE.MeshBasicMaterial({ color: "#ffe066", transparent: true, opacity: 0.35, depthWrite: false }),
    // themed: desk tops / desk rails, and the custom-kind box materials
    finish: new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.grain, roughness: 0.7, metalness: 0 }),
    rail: new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.grain, roughness: 0.6, metalness: 0.05 }),
    glossy: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.15 }),
    glass: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.38, depthWrite: false }),
    emissive: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true }),
    // room surfaces (persist across room rebuilds so a theme fade survives a grid change)
    floor: fadeMaterial({ map: floorTex("wood"), roughness: 0.78 }),
    wallPlain: fadeMaterial({ vertexColors: true, map: wallTex("plaster"), roughness: 0.95 }),
    wallBack: fadeMaterial({ vertexColors: true, map: wallTex("plaster"), roughness: 0.95 }),
    wallLeft: fadeMaterial({ vertexColors: true, map: wallTex("plaster"), roughness: 0.95 }),
    trim: new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.grain, roughness: 0.8 }),
  };
  mats.emissive.userData = { baseColor: new THREE.Color("#ffffff"), lamp: false, window: false };
  const charBase = baseMaterial(tex.grain);
  const charAway = awayMaterial(tex.grain);

  const S = {
    theme: "day", grid: null, items: [], agents: [], seating: new Map(), spots: [], blocked: null, entry: { x: 0, z: 0 },
    room: null, walls: {}, furniture: new THREE.Group(), batches: new Map(), texts: new Map(), itemAnim: new Map(), leavingItems: new Map(),
    chars: new Map(), lampLights: [], glowMats: new Map(), selectedItem: null, ghost: null, hidden: new Set(), follow: null, drag: null,
    camAnim: null, insets: { left: 0, right: 0 }, clock: 0, last: performance.now(), size: { w: 1, h: 1 }, frameCbs: [], raf: 0, raycaster: new THREE.Raycaster(),
    custom: {}, look: themeLook(DEFAULT_THEME), palette: null, fade: null, kindColor: new Map(), assign: new Map(),
    logo: { id: null, img: null, tex: null }, assets: [], themeObj: null, fetchAsset, onError,
  };
  scene.add(S.furniture);

  /* ── kind assets ───────────────────────────────────────────────────────────────────────────── */

  const kindAssets = new Map();
  const screenMats = new Set();

  /** The current screen picture: the office logo when there is one, else the classic code lines / dashboard. */
  const screenMap = (m) => (m.userData.logo ? S.logo.tex ?? m.userData.fallback : m.userData.fallback);

  /**
   * Everything needed to draw one kind: parts [{role, geo, mat}] in the item frame, the model's text panel
   * and accent default. Built-ins come from furniture.js, custom kinds from their boxes (kindGeometryPlan).
   */
  function assetsFor(kind) {
    if (kindAssets.has(kind)) return kindAssets.get(kind);
    const a = Object.hasOwn(MODELS, kind) ? builtinAssets(kind) : customAssets(kind);
    kindAssets.set(kind, a);
    return a;
  }

  function builtinAssets(kind) {
    const m = MODELS[kind]();
    const parts = [];
    if (m.base.length) parts.push({ role: "base", geo: buildGeometry(m.base), mat: mats.base });
    if (m.finish?.length) parts.push({ role: "finish", geo: buildGeometry(m.finish), mat: mats.finish });
    if (m.rail?.length) parts.push({ role: "rail", geo: buildGeometry(m.rail), mat: mats.rail });
    if (m.accent.length) parts.push({ role: "accent", geo: buildGeometry(m.accent), mat: m.accentMap === "rug" ? mats.rug : mats.accent });
    if (m.glow) {
      const fallback = m.glow.tex === "window" ? tex.windowDay : m.glow.tex ? tex[m.glow.tex] : null;
      const glowMat = new THREE.MeshBasicMaterial({ map: fallback, color: m.glow.color ?? "#ffffff", toneMapped: true });
      const screen = m.glow.tex === "screen" || m.glow.tex === "tv";
      glowMat.userData = { baseColor: new THREE.Color(m.glow.color ?? "#ffffff"), lamp: !!m.glow.lamp, window: m.glow.tex === "window", screen, fallback, logo: screen && !!kindOf(kind)?.screen };
      if (screen) { glowMat.map = screenMap(glowMat); screenMats.add(glowMat); }
      S.glowMats.set(kind, glowMat);
      applyGlow(glowMat);
      parts.push({ role: "glow", geo: buildGeometry(m.glow.boxes, { ao: false }), mat: glowMat });
    }
    return { parts, model: m, defaultColor: new THREE.Color(m.defaultColor), custom: false };
  }

  function customAssets(kind) {
    const def = S.custom[kind];
    if (!def) throw new Error(`no model for kind "${kind}" (not built in, not defined in this office)`);
    const plan = kindGeometryPlan(def);
    const boxes = (list, extra = {}) => list.map((b) => vbox(b.cx, b.y0, b.cz, b.w, b.h, b.d, b.color, extra));
    const parts = [];
    if (plan.matte.length) parts.push({ role: "base", geo: buildGeometry(boxes(plan.matte)), mat: mats.base });
    if (plan.glossy.length) parts.push({ role: "base", geo: buildGeometry(boxes(plan.glossy)), mat: mats.glossy });
    if (plan.glass.length) parts.push({ role: "glass", geo: buildGeometry(boxes(plan.glass), { ao: false }), mat: mats.glass });
    if (plan.emissive.length) {
      S.glowMats.set("@emissive", mats.emissive);
      applyGlow(mats.emissive);
      parts.push({ role: "emissive", geo: buildGeometry(boxes(plan.emissive), { ao: false }), mat: mats.emissive });
    }
    if (plan.screen.length) {
      const glowMat = new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: true });
      glowMat.userData = { baseColor: new THREE.Color("#ffffff"), lamp: false, window: false, screen: true, fallback: tex.screen, own: true, logo: def.screen };
      glowMat.map = screenMap(glowMat);
      screenMats.add(glowMat);
      S.glowMats.set(`@screen:${kind}`, glowMat);
      applyGlow(glowMat);
      parts.push({ role: "glow", geo: buildGeometry(boxes(plan.screen, { unitUV: true }), { ao: false }), mat: glowMat });
    }
    // a textable custom kind gets a sign-like panel on its front face, sized to the model
    let text = null;
    if (def.textable) {
      let top = 0;
      for (const b of def.boxes) top = Math.max(top, (b.y + b.h) / 16);
      const w = Math.max(0.4, def.w * 0.86), h = Math.min(Math.max(0.3, top * 0.6), 1.2);
      text = { x: 0, y: Math.max(h / 2 + 0.05, top - h / 2 - 0.08), z: def.d / 2 + 0.006, w, h, bg: S.look.signBg, fg: S.look.signFg, tw: Math.round(172 * w), th: Math.round(172 * h) };
    }
    return { parts, model: { text, noShadow: def.layer === "floor" }, defaultColor: new THREE.Color("#ffffff"), custom: true, plan };
  }

  /** Forget a kind's cached geometry (it was redefined or removed). */
  function dropKind(kind) {
    const a = kindAssets.get(kind);
    if (!a) return;
    for (const p of a.parts) {
      p.geo.dispose();
      if (p.mat.userData?.own) { screenMats.delete(p.mat); p.mat.dispose(); S.glowMats.delete(`@screen:${kind}`); }
    }
    kindAssets.delete(kind);
  }

  /* ── room ──────────────────────────────────────────────────────────────────────────────────── */

  function disposeTree(o) {
    o.traverse((c) => {
      if (c.userData.ownGeo && c.geometry) c.geometry.dispose();
      if (c.userData.ownMat && c.material) for (const mm of [].concat(c.material)) { mm.map?.dispose?.(); mm.dispose(); }
    });
  }

  function buildRoom(grid) {
    if (S.room) { scene.remove(S.room); disposeTree(S.room); }
    const g = new THREE.Group();
    const W = grid.w, D = grid.d;
    const own = (mesh) => { mesh.userData.ownGeo = true; return mesh; };

    // floor: one texture tile per cell (UVs scaled, so the shared themed textures need no per-grid repeat)
    const floorGeo = new THREE.PlaneGeometry(W, D);
    const fuv = floorGeo.attributes.uv;
    for (let i = 0; i < fuv.count; i++) fuv.setXY(i, fuv.getX(i) * W, fuv.getY(i) * D);
    const floor = own(new THREE.Mesh(floorGeo, mats.floor));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(W / 2, 0, D / 2);
    floor.receiveShadow = true;
    floor.name = "floor";
    g.add(floor);

    // garden slab: grass top, stone plinth sides
    const gw = W + BORDER * 2, gd = D + BORDER * 2;
    const grass = tex.grass.clone(); grass.needsUpdate = true; grass.repeat.set(gw, gd);
    const edgeX = tex.plinth.clone(); edgeX.needsUpdate = true; edgeX.repeat.set(gw, 1);
    const edgeZ = tex.plinth.clone(); edgeZ.needsUpdate = true; edgeZ.repeat.set(gd, 1);
    const side = (t) => new THREE.MeshStandardMaterial({ map: t, roughness: 1 });
    const slabMats = [side(edgeZ), side(edgeZ), new THREE.MeshStandardMaterial({ map: grass, roughness: 1 }), side(edgeX), side(edgeX), side(edgeX)];
    const slab = own(new THREE.Mesh(new THREE.BoxGeometry(gw, 1, gd), slabMats));
    slab.userData.ownMat = true;
    slab.position.set(W / 2, -0.505, D / 2);
    slab.receiveShadow = true;
    g.add(slab);

    // garden dressing: trees, bushes, flowers, a stone path to the door — all voxels, all seeded
    const deco = [];
    let seed = hashStr(`${W}x${D}`);
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const tree = (x, z, s) => {
      deco.push(vbox(x, -0.01, z, 0.3 * s, 1.1 * s, 0.3 * s, "#8a5a3a"));
      deco.push(vbox(x, 0.9 * s, z, 1.2 * s, 0.8 * s, 1.2 * s, "#4f9c43"));
      deco.push(vbox(x + 0.1 * s, 1.55 * s, z - 0.05 * s, 0.8 * s, 0.5 * s, 0.8 * s, "#5fae4e"));
      deco.push(vbox(x - 0.25 * s, 1.2 * s, z + 0.3 * s, 0.5 * s, 0.4 * s, 0.5 * s, "#72c05a"));
    };
    const bush = (x, z) => { deco.push(vbox(x, -0.01, z, 0.7, 0.45, 0.6, "#5aa64a")); deco.push(vbox(x + 0.1, 0.35, z, 0.4, 0.25, 0.4, "#6cba57")); };
    const flower = (x, z, c) => { deco.push(vbox(x, -0.01, z, 0.04, 0.2, 0.04, "#3f8a3a")); deco.push(vbox(x, 0.19, z, 0.12, 0.1, 0.12, c)); };
    const ring = [];
    for (let x = -1.6; x < W + 1.6; x += 1.4) { ring.push([x, -1.4], [x, D + 1.4]); }
    for (let z = 0; z < D; z += 1.4) { ring.push([-1.4, z], [W + 1.4, z]); }
    for (const [x, z] of ring) {
      const r = rnd();
      if (Math.abs(x - W / 2) < 1.6 && z > D) continue;
      if (r < 0.16) tree(x + (rnd() - 0.5) * 0.4, z + (rnd() - 0.5) * 0.4, 0.8 + rnd() * 0.5);
      else if (r < 0.38) bush(x, z);
      else if (r < 0.62) flower(x + rnd() * 0.6, z + rnd() * 0.6, ["#ff8fa8", "#ffd45c", "#ffffff", "#b99bff"][Math.floor(rnd() * 4)]);
    }
    for (let z = D + 0.3; z < D + BORDER; z += 0.7) deco.push(vbox(W / 2 + (rnd() - 0.5) * 0.2, -0.04, z, 0.9, 0.06, 0.5, "#c9c2b4"));
    if (deco.length) {
      const dm = own(new THREE.Mesh(buildGeometry(deco, { floorY: 0 }), mats.base));
      dm.castShadow = true; dm.receiveShadow = true;
      g.add(dm);
    }

    // walls: full + low stub each, the camera-side ones swap to the stub (cutaway). The body is white
    // boxes on a themed material (plaster / brick / wood panels × wall colour); cap, baseboard and posts
    // are white/grey boxes on the trim material.
    const wallBoxes = (len, doorAt) => {
      const segs = doorAt == null ? [[0, len]] : [[0, doorAt - 1], [doorAt + 1, len]];
      const body = [], trim = [], stubBody = [], stubTrim = [];
      for (const [a, b] of segs) {
        const L = b - a, c = (a + b) / 2;
        body.push(vbox(c, 0, -0.12, L, WALL_H, 0.24, "#ffffff"));
        trim.push(vbox(c, WALL_H, -0.12, L + 0.02, 0.1, 0.3, "#ffffff"));
        trim.push(vbox(c, 0, 0.015, L, 0.14, 0.03, "#d8d8d8"));
        stubBody.push(vbox(c, 0, -0.12, L, 0.32, 0.24, "#ffffff"));
        stubTrim.push(vbox(c, 0.32, -0.12, L + 0.02, 0.06, 0.3, "#ffffff"));
      }
      if (doorAt != null) body.push(vbox(doorAt, 2.1, -0.12, 2, WALL_H - 2.1, 0.24, "#ffffff"));
      return { body, trim, stubBody, stubTrim };
    };
    const mkWall = (len, doorAt, bodyMat) => {
      const wb = wallBoxes(len, doorAt);
      const grp = new THREE.Group();
      const full = new THREE.Group();
      for (const [boxes, mat] of [[wb.body, bodyMat], [wb.trim, mats.trim]]) {
        const m = own(new THREE.Mesh(buildGeometry(boxes), mat));
        m.castShadow = true; m.receiveShadow = true;
        full.add(m);
      }
      const stub = new THREE.Group();
      for (const [boxes, mat] of [[wb.stubBody, bodyMat], [wb.stubTrim, mats.trim]]) {
        const m = own(new THREE.Mesh(buildGeometry(boxes), mat));
        m.receiveShadow = true;
        stub.add(m);
      }
      stub.visible = false;
      grp.add(full, stub);
      return { grp, full, stub };
    };
    const back = mkWall(W, null, mats.wallBack); // along +x at z = 0, inner face +z
    const front = mkWall(W, W / 2, mats.wallPlain);
    front.grp.rotation.y = Math.PI; front.grp.position.set(W, 0, D);
    const left = mkWall(D, null, mats.wallLeft); // along +z at x = 0, inner face +x
    left.grp.rotation.y = Math.PI / 2; left.grp.position.set(0, 0, D);
    const right = mkWall(D, null, mats.wallPlain);
    right.grp.rotation.y = -Math.PI / 2; right.grp.position.set(W, 0, 0);
    // corner posts
    const posts = [];
    for (const [x, z] of [[0, 0], [W, 0], [0, D], [W, D]]) posts.push(vbox(x, 0, z, 0.3, WALL_H + 0.12, 0.3, "#ffffff"));
    const postMesh = own(new THREE.Mesh(buildGeometry(posts), mats.trim));
    postMesh.castShadow = true;
    g.add(back.grp, front.grp, left.grp, right.grp, postMesh);
    S.walls = { back, front, left, right, posts: postMesh };

    // sun + shadow frustum
    const c = new THREE.Vector3(W / 2, 0, D / 2);
    const R = Math.hypot(W, D) / 2 + BORDER + 1;
    sun.position.copy(c).add(new THREE.Vector3(-0.55, 1, 0.75).normalize().multiplyScalar(R * 2.4));
    sun.target.position.copy(c);
    const sc = sun.shadow.camera;
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 0.5; sc.far = R * 5;
    sc.updateProjectionMatrix();

    scene.add(g);
    g.updateMatrixWorld(true);
    S.room = g;
  }

  function updateCutaway() {
    if (!S.grid || !S.walls.back) return;
    const p = camera.position, { w: W, d: D } = S.grid;
    const set = (wall, hide) => { wall.full.visible = !hide; wall.stub.visible = hide; };
    set(S.walls.back, p.z < 0.5);
    set(S.walls.front, p.z > D - 0.5);
    set(S.walls.left, p.x < 0.5);
    set(S.walls.right, p.x > W - 0.5);
  }

  /* ── furniture ─────────────────────────────────────────────────────────────────────────────── */

  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  const tmpC = new THREE.Color();

  function itemScale(id, now) {
    const a = S.itemAnim.get(id);
    if (!a) return 1;
    const k = Math.min(1, (now - a.t0) / POP_MS);
    if (a.kind === "out") return Math.max(0.001, 1 - easeInOut(k));
    if (a.kind === "bump") return 1 + Math.sin(k * Math.PI) * 0.12;
    return Math.max(0.001, easeOutBack(k));
  }

  function rebuildFurniture() {
    for (const b of S.batches.values()) for (const m of b.meshes) m.parent?.remove(m), m.dispose();
    S.batches.clear();
    // a leaving item of a kind that no longer exists can't be drawn: drop it
    for (const [id, it] of S.leavingItems) if (!kindOf(it.kind, S.custom)) S.leavingItems.delete(id);
    const all = [...S.items, ...S.leavingItems.values()];
    const { batches, texts } = layoutBatches(all, S.custom);
    for (const [key, insts] of batches) {
      const kind = insts[0].kind;
      const a = assetsFor(kind);
      const parent = insts[0].wall ? S.walls[insts[0].wall].full : S.furniture;
      const meshes = [];
      for (const part of a.parts) {
        const lit = part.role !== "glow" && part.role !== "emissive";
        const im = new THREE.InstancedMesh(part.geo, part.mat, insts.length);
        im.castShadow = !a.model.noShadow && lit && part.role !== "glass";
        im.receiveShadow = lit;
        im.userData.role = part.role;
        im.userData.key = key;
        im.frustumCulled = false;
        if (part.role === "glass") im.renderOrder = 1;
        parent.add(im);
        meshes.push(im);
      }
      const batch = { key, kind, insts, meshes, wall: insts[0].wall };
      S.batches.set(key, batch);
      writeBatch(batch, performance.now());
    }
    syncTexts(texts);
    updateLampLights();
  }

  function writeBatch(batch, now) {
    const parentInv = batch.wall ? new THREE.Matrix4().copy(S.walls[batch.wall].grp.matrixWorld).invert() : null;
    batch.insts.forEach((inst, i) => {
      const s = S.hidden.has(inst.id) ? 0.0001 : itemScale(inst.id, now);
      tmpP.set(inst.x, 0, inst.z);
      tmpQ.setFromAxisAngle(UP, inst.yaw);
      tmpS.set(s, s, s);
      tmpM.compose(tmpP, tmpQ, tmpS);
      if (parentInv) tmpM.premultiply(parentInv);
      for (const m of batch.meshes) {
        m.setMatrixAt(i, tmpM);
        if (m.userData.role === "accent") {
          if (inst.color) m.setColorAt(i, tmpC.set(inst.color));
          else m.setColorAt(i, S.kindColor.get(batch.kind) ?? assetsFor(batch.kind).defaultColor);
        } else if (m.userData.role === "glow" && batch.kind === "desk") {
          m.setColorAt(i, tmpC.setScalar(deskGlow(inst.id)));
        } else if (m.userData.role === "glow") {
          m.setColorAt(i, tmpC.setScalar(1));
        }
      }
    });
    for (const m of batch.meshes) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  function deskGlow(deskId) {
    for (const [agentId, desk] of S.seating) {
      if (desk.id !== deskId) continue;
      const ag = S.agents.find((x) => x.id === agentId);
      if (!ag) return S.logo.tex ? 0.45 : 0.08;
      return ag.status === "working" ? 1 : ag.status === "away" ? 0.25 : 0.6;
    }
    // with a logo, empty desks show it dimmed (a screensaver) instead of a dark screen
    return S.logo.tex ? 0.45 : 0.08;
  }

  /** Signs follow the theme's ink colours and, when the theme says so, carry the logo. */
  function panelStyle(t, spec) {
    const sign = t.kind === "sign" || assetsFor(t.kind).custom;
    const logo = sign && S.look.logoOnSigns && S.logo.img ? S.logo.img : null;
    return { bg: sign ? S.look.signBg : spec.bg, fg: sign ? S.look.signFg : spec.fg, logo };
  }
  const textSig = (t, st) => `${t.text}|${t.color}|${t.x}|${t.z}|${t.yaw}|${st.bg}|${st.fg}|${st.logo ? S.logo.id : ""}`;

  function syncTexts(texts) {
    S.lastTexts = texts;
    const want = new Map(texts.map((t) => [t.id, t]));
    for (const [id, o] of S.texts) {
      const t = want.get(id);
      const spec = t && assetsFor(t.kind).model.text;
      if (!t || !spec || o.userData.sig !== textSig(t, panelStyle(t, spec))) {
        o.parent?.remove(o);
        o.geometry.dispose(); o.material.map.dispose(); o.material.dispose();
        S.texts.delete(id);
      }
    }
    for (const t of texts) {
      if (S.texts.has(t.id)) continue;
      const spec = assetsFor(t.kind).model.text;
      if (!spec) throw new Error(`textable kind ${t.kind} has no text panel in its model`);
      const st = panelStyle(t, spec);
      const map = st.logo
        ? T.logoTextTexture(st.logo, t.text, { bg: st.bg, fg: st.fg, w: spec.tw * 2, h: spec.th * 2 })
        : T.textTexture(t.text, { bg: st.bg, fg: st.fg, w: spec.tw, h: spec.th });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.w, spec.h), new THREE.MeshStandardMaterial({ map, roughness: 0.9 }));
      mesh.userData.sig = textSig(t, st);
      mesh.userData.itemId = t.id;
      mesh.receiveShadow = true;
      const holder = new THREE.Group();
      holder.position.set(t.x, 0, t.z);
      holder.rotation.y = t.yaw;
      mesh.position.set(spec.x, spec.y, spec.z);
      holder.add(mesh);
      holder.updateMatrixWorld(true);
      // keep the panel itself in S.texts; reparent so it hides with its wall
      const parent = t.wall ? S.walls[t.wall].full : S.furniture;
      parent.updateMatrixWorld(true);
      const wm = mesh.matrixWorld.clone();
      mesh.matrix.copy(parent.matrixWorld.clone().invert().multiply(wm));
      mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      parent.add(mesh);
      S.texts.set(t.id, mesh);
    }
  }

  function updateLampLights() {
    for (const l of S.lampLights) scene.remove(l);
    S.lampLights = [];
    const th = THEMES[S.theme];
    const pal = S.palette;
    const lamps = S.items.filter((it) => it.kind === "lamp" || it.kind === "tv").slice(0, 6);
    for (const it of lamps) {
      const f = footprint(it);
      const pl = new THREE.PointLight(it.kind === "lamp" ? pal.lamp : "#8fb6ff", th.point * (it.kind === "lamp" ? 1 : 0.4), 7, 1.6);
      pl.userData.lamp = it.kind === "lamp";
      pl.position.set(f.x + f.w / 2, it.kind === "lamp" ? 1.4 : 1.0, f.z + f.d / 2);
      pl.visible = th.point > 0;
      scene.add(pl);
      S.lampLights.push(pl);
    }
    // a soft warm "ceiling" fill at night so the room isn't a cave
    // a crowded floor (lots of desks) swallows light, so the fill grows with the furniture count
    const density = Math.min(1, S.items.filter((it) => kindOf(it.kind, S.custom)?.layer === "object").length / (S.grid.w * S.grid.d * 0.12));
    const fill = new THREE.PointLight(pal.fill, th.point * (2.2 + 1.6 * density), Math.hypot(S.grid.w, S.grid.d), 1.2);
    fill.position.set(S.grid.w / 2, 4.5, S.grid.d / 2);
    fill.visible = th.point > 0;
    fill.userData.fill = true;
    scene.add(fill);
    S.lampLights.push(fill);
  }

  /* ── characters ────────────────────────────────────────────────────────────────────────────── */

  function addChar(agent, now, initial) {
    const obj = buildCharacter(agent, tex.grain);
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), mats.blob);
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.012;
    obj.add(blob);
    const hit = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.4, 0.7), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.7;
    hit.userData.agentId = agent.id;
    obj.add(hit);
    const c = {
      id: agent.id, agent, obj, hit, blob, pos: { x: S.entry.x, z: S.entry.z }, yaw: Math.PI,
      path: [], target: null, pose: "stand", phase: (hashStr(agent.id) % 1000) / 100, pop: { kind: "in", t0: now }, leaving: false,
      seatY: SEAT_Y, until: 0, arrivedAt: 0, salt: 0, spotId: null, restless: false, away: false, waveUntil: initial ? 0 : now + 2200,
    };
    if (initial) c.placeOnArrive = true;
    obj.position.set(c.pos.x, 0, c.pos.z);
    scene.add(obj);
    S.chars.set(agent.id, c);
    return c;
  }

  function setAway(c, away) {
    if (c.away === away) return;
    c.away = away;
    c.obj.traverse((o) => { if (o.isMesh && o !== c.hit && o !== c.blob) o.material = away ? charAway : charBase; });
  }

  /** Where an agent should go: its desk while working, else the seat/station it was assigned, else mill about. */
  function targetFor(agent, spot, salt = 0) {
    const desk = S.seating.get(agent.id);
    const { pose, place } = poseFor(agent, !!desk);
    if (place === "desk" && desk) {
      const s = seatOf(desk);
      return { key: `desk:${desk.id}`, at: { x: s.x, z: s.z }, yaw: s.yaw, pose, seatY: SEAT_Y };
    }
    if (spot) {
      return { key: `spot:${spot.id}`, spotId: spot.id, at: { x: spot.x, z: spot.z }, yaw: spot.yaw, pose: pose === "wave" ? "wave" : spot.pose, seatY: spot.seatY ?? SEAT_Y, duration: spot.duration };
    }
    // nowhere to go: mill about near the entrance, spread out by id
    const h = hashStr(agent.id + salt);
    return { key: `mill:${h % 97}`, at: { x: S.entry.x + ((h % 5) - 2) * 0.9, z: Math.max(0.5, S.entry.z - 1 - ((h >> 3) % 3) * 0.9) }, yaw: Math.PI, pose: pose === "wave" ? "wave" : "stand", seatY: SEAT_Y };
  }

  function retarget() {
    const live = [...S.chars.values()].filter((c) => !c.leaving);
    // lounge-bound agents (idle, or deskless) share the seats and stations, one each, stable
    const wanters = live.filter((c) => poseFor(c.agent, S.seating.has(c.agent.id)).place === "lounge")
      .map((c) => ({ id: c.id, joinedAt: c.agent.joinedAt, salt: c.salt, current: c.spotId, restless: c.restless }));
    S.assign = assignSpots(wanters, S.spots);
    for (const c of live) {
      const spot = S.assign.get(c.id) ?? null;
      const t = targetFor(c.agent, spot, c.salt);
      c.spotId = spot?.id ?? null;
      c.restless = false;
      if (c.placeOnArrive) {
        // first snapshot: everyone is already where they belong, no parade from the door
        c.placeOnArrive = false;
        c.pos = { x: t.at.x, z: t.at.z };
        c.yaw = t.yaw;
        c.target = t;
        c.path = [];
        c.arrivedAt = performance.now() - Math.random() * 20000;
        c.until = 0;
      } else if (!c.target || c.target.key !== t.key) {
        c.target = t;
        c.path = route(S.blocked, S.grid, c.pos, t.at);
        c.until = 0;
      } else {
        c.target = { ...c.target, pose: t.pose, yaw: t.yaw, seatY: t.seatY, duration: t.duration };
      }
      setAway(c, c.agent.status === "away");
    }
  }

  function stepChar(c, dt, now) {
    let pose;
    if (c.path.length) {
      const wp = c.path[0];
      const dx = wp.x - c.pos.x, dz = wp.z - c.pos.z;
      const dist = Math.hypot(dx, dz);
      const step = WALK_SPEED * dt;
      if (dist <= step) { c.pos.x = wp.x; c.pos.z = wp.z; c.path.shift(); } else { c.pos.x += (dx / dist) * step; c.pos.z += (dz / dist) * step; }
      if (dist > 0.01) c.yaw += angDiff(c.yaw, Math.atan2(dx, dz)) * Math.min(1, dt * 10);
      pose = "walk";
    } else if (c.target) {
      c.yaw += angDiff(c.yaw, c.target.yaw) * Math.min(1, dt * 8);
      pose = c.waveUntil > now ? "wave" : c.target.pose;
      // settled on a seat/station: stay for its duration (± a little), then move on to another
      if (!c.until) c.until = (c.arrivedAt || now) + ((c.target.duration ?? 40) * (0.8 + Math.random() * 0.4)) * 1000;
      c.arrivedAt = 0;
      if (c.agent.status === "idle" && now > c.until && !c.leaving) {
        c.salt++;
        c.restless = true;
        retarget();
      }
    } else pose = "stand";
    if (c.leaving) pose = "wave";
    c.pose = pose;
    applyProps(c.obj, pose);
    const a = limbAngles(pose, S.clock, c.phase);
    applyLimbs(c.obj, a, c.target?.seatY ?? SEAT_Y);
    blink(c.obj, S.clock, c.phase);
    let s = 1;
    if (c.pop) {
      const k = Math.min(1, (now - c.pop.t0) / POP_MS);
      s = c.pop.kind === "out" ? Math.max(0.001, 1 - easeInOut(k)) : Math.max(0.001, easeOutBack(k));
      if (k >= 1) {
        if (c.pop.kind === "out") return false;
        c.pop = null;
      }
    }
    c.obj.scale.setScalar(s);
    // seated characters scoot into the chair a touch
    const seated = SEATED.has(pose) || pose === "sit";
    c.obj.position.set(c.pos.x, 0, c.pos.z);
    c.blob.visible = !seated;
    c.obj.rotation.y = c.yaw;
    return true;
  }

  /* ── state sync ────────────────────────────────────────────────────────────────────────────── */

  function setState(state) {
    const now = performance.now();
    const gridChanged = !S.grid || S.grid.w !== state.grid.w || S.grid.d !== state.grid.d;
    if (gridChanged) {
      S.grid = { ...state.grid };
      buildRoom(S.grid);
      resetView(false);
    }
    // custom kinds: a redefined kind rebuilds its geometry and bumps every placed copy
    const custom = state.customKinds ?? {};
    const redefined = new Set();
    for (const k of new Set([...Object.keys(S.custom), ...Object.keys(custom)])) {
      if (S.custom[k] !== custom[k]) { redefined.add(k); dropKind(k); }
    }
    S.custom = custom;
    // items: diff for pop animations
    const prev = new Map(S.items.map((i) => [i.id, i]));
    const next = new Map(state.items.map((i) => [i.id, i]));
    let itemsChanged = gridChanged || prev.size !== next.size || redefined.size > 0;
    for (const it of state.items) if (redefined.has(it.kind) && prev.has(it.id)) S.itemAnim.set(it.id, { kind: "bump", t0: now });
    for (const [id, it] of next) {
      const p = prev.get(id);
      if (!p) { if (S.items.length || !S.firstItemsSeen) S.itemAnim.set(id, { kind: "in", t0: now + Math.random() * 120 }); itemsChanged = true; S.leavingItems.delete(id); }
      else if (p !== it && (p.x !== it.x || p.z !== it.z || p.rot !== it.rot || p.text !== it.text || p.color !== it.color || p.kind !== it.kind)) {
        S.itemAnim.set(id, { kind: p.x !== it.x || p.z !== it.z ? "in" : "bump", t0: now });
        itemsChanged = true;
      }
    }
    for (const [id, it] of prev) {
      if (!next.has(id)) { S.leavingItems.set(id, it); S.itemAnim.set(id, { kind: "out", t0: now }); itemsChanged = true; }
    }
    S.firstItemsSeen = true;
    S.items = state.items;
    S.agents = state.agents;
    S.seating = deskSeating(state.agents, state.items);
    if (itemsChanged) {
      S.blocked = blockedCells(S.items, S.grid, S.custom);
      S.spots = usableSpots(idleSpots(S.items, S.custom), S.blocked, S.grid);
      S.entry = entryPoint(S.blocked, S.grid);
      rebuildFurniture();
    } else {
      const desks = S.batches.get("desk");
      if (desks) writeBatch(desks, now);
    }
    // agents
    const live = new Set();
    const initial = !S.agentsSeen;
    for (const a of state.agents) {
      live.add(a.id);
      const c = S.chars.get(a.id);
      if (!c) addChar(a, now, initial);
      else { c.agent = a; if (c.leaving) { c.leaving = false; c.pop = { kind: "in", t0: now }; } }
    }
    S.agentsSeen = true;
    for (const c of S.chars.values()) {
      if (!live.has(c.id) && !c.leaving) {
        c.leaving = true;
        c.pop = { kind: "out", t0: now + 900 };
        c.path = [];
      }
    }
    if (itemsChanged) for (const c of S.chars.values()) if (c.target) c.path = route(S.blocked, S.grid, c.pos, c.target.at);
    retarget();
    // design: palette/materials (crossfaded after the first paint) and the logo on every screen
    const theme = state.theme ?? DEFAULT_THEME;
    if (theme !== S.themeObj) {
      const first = !S.themeObj;
      S.themeObj = theme;
      applyLook(themeLook(theme), !first);
    }
    S.assets = state.assets ?? [];
    syncLogo();
  }

  /* ── theme ─────────────────────────────────────────────────────────────────────────────────── */

  /** Time of day: "day" | "night" (the office theme — palette and materials — is applyLook). */
  function setTheme(theme) {
    if (!THEMES[theme]) throw new Error(`unknown theme ${theme}`);
    S.theme = theme;
    const th = THEMES[theme];
    hemi.intensity = th.hemi;
    sun.intensity = th.sun;
    scene.background = theme === "night" ? tex.skyNight : tex.skyDay;
    scene.fog.color.set(th.fog);
    bloom.strength = th.bloom; bloom.threshold = th.threshold;
    renderer.toneMappingExposure = th.exposure;
    for (const m of S.glowMats.values()) applyGlow(m);
    applyLights();
    if (S.grid) updateLampLights();
  }

  function applyGlow(m) {
    const th = THEMES[S.theme];
    const night = S.theme === "night";
    m.color.copy(m.userData.baseColor).multiplyScalar(m.userData.lamp ? th.lamp : th.glow);
    if (m.userData.window) {
      const map = night ? nightWindowTex(S.look.nightWindow) : tex.windowDay;
      if (m.map !== map) { m.map = map; m.needsUpdate = true; }
      m.color.setScalar(night ? 0.95 : 1.05);
    }
  }

  /** Sun / sky / lamp tints: the lighting mood of the theme over the time of day. */
  function applyLights() {
    const th = THEMES[S.theme], p = S.palette;
    if (!p) return;
    const night = S.theme === "night";
    hemi.color.copy(night ? p.nightSky : p.sky);
    hemi.groundColor.copy(night ? tmpC.set(th.hemiGround) : p.ground);
    sun.color.copy(night ? tmpC.set(th.sunColor) : p.sun);
    for (const l of S.lampLights) l.color.copy(l.userData.fill ? p.fill : l.userData.lamp ? p.lamp : l.color);
  }

  /* ── office theme: palette + materials, crossfaded ─────────────────────────────────────────── */

  function paletteFor(look) {
    const C = (h) => new THREE.Color(h);
    const wallFor = (w) => (look.walls.accent?.wall === w ? look.walls.accent.color : look.walls.color);
    return {
      floor: C(look.floor.color), wallPlain: C(look.walls.color), wallBack: C(wallFor("back")), wallLeft: C(wallFor("left")),
      trim: C(look.walls.trim), finish: C(look.desk.wood), rail: C(look.desk.rail),
      sun: C(look.mood.sun), sky: C(look.mood.sky), ground: C(look.mood.ground), lamp: C(look.mood.lamp), fill: C(look.mood.fill), nightSky: C(look.mood.nightSky),
      kinds: new Map(Object.entries(look.kindColors).map(([k, v]) => [k, C(v)])),
      floorRough: look.floor.roughness,
    };
  }

  function lerpPalette(a, b, k) {
    const out = { kinds: new Map(), floorRough: a.floorRough + (b.floorRough - a.floorRough) * k };
    for (const key of Object.keys(b)) if (b[key] instanceof THREE.Color) out[key] = a[key].clone().lerp(b[key], k);
    for (const [kind, c] of b.kinds) out.kinds.set(kind, (a.kinds.get(kind) ?? c).clone().lerp(c, k));
    return out;
  }

  const FADE_SURFACES = ["floor", "wallPlain", "wallBack", "wallLeft"];
  function surfaceTex(look, key) {
    if (key === "floor") return floorTex(look.floor.material);
    const acc = look.walls.accent;
    const wall = key === "wallBack" ? "back" : key === "wallLeft" ? "left" : null;
    return acc && acc.wall === wall ? wallTex(acc.material) : wallTex("plaster");
  }

  function paintPalette(p) {
    S.palette = p;
    for (const key of [...FADE_SURFACES, "trim", "finish", "rail"]) mats[key].color.copy(p[key]);
    mats.floor.roughness = p.floorRough;
    S.kindColor = p.kinds;
    applyLights();
  }

  /** Switch to a new look; `animate` crossfades colours and surface textures over FADE_MS. */
  function applyLook(look, animate) {
    const to = paletteFor(look);
    S.look = look;
    for (const key of FADE_SURFACES) {
      const u = mats[key].userData.xfade;
      if (S.fade) { mats[key].map = u.uMix.value > 0.5 ? u.map2.value : mats[key].map; u.uMix.value = 0; }
      const target = surfaceTex(look, key);
      if (animate) u.map2.value = target;
      else { mats[key].map = target; u.map2.value = target; u.uMix.value = 0; }
    }
    if (animate && S.palette) S.fade = { t0: performance.now(), from: S.palette, to };
    else { S.fade = null; paintPalette(to); }
    for (const m of S.glowMats.values()) applyGlow(m);
    if (S.logo.img) setLogoTex(S.logo.img);
    if (S.lastTexts) syncTexts(S.lastTexts);
    if (S.grid) updateLampLights();
  }

  function stepFade(now) {
    const F = S.fade;
    if (!F) return false;
    const k = Math.min(1, (now - F.t0) / FADE_MS), e = easeInOut(k);
    paintPalette(lerpPalette(F.from, F.to, e));
    for (const key of FADE_SURFACES) mats[key].userData.xfade.uMix.value = e;
    if (k >= 1) {
      for (const key of FADE_SURFACES) { const u = mats[key].userData.xfade; mats[key].map = u.map2.value; u.uMix.value = 0; }
      S.fade = null;
    }
    return true;
  }

  /* ── logo on screens ───────────────────────────────────────────────────────────────────────── */

  function syncLogo() {
    const id = S.look.logo;
    if (id === S.logo.id) return;
    S.logo.id = id;
    if (!id) { setLogoTex(null); return; }
    const asset = S.assets.find((a) => a.id === id);
    if (!asset) {
      // the theme frame beat its asset frame: show the plain screens and try again on the next state update
      console.warn(`office: the theme's logo ${id} isn't among this office's assets yet`);
      S.logo.id = null;
      if (S.logo.img) setLogoTex(null);
      return;
    }
    S.fetchAsset(asset.url)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); })
      .then((b) => createImageBitmap(b))
      .then((img) => { if (S.logo.id === id) setLogoTex(img); })
      .catch((e) => { console.error("office: logo load failed", e); S.onError(`couldn't load the office logo (${asset.url}): ${e.message}`); });
  }

  function setLogoTex(img) {
    S.logo.tex?.dispose();
    S.logo.img = img;
    S.logo.tex = img ? T.logoScreenTexture(img, { bg: S.look.screenBg }) : null;
    for (const m of screenMats) { m.map = screenMap(m); m.needsUpdate = true; }
    if (S.lastTexts) syncTexts(S.lastTexts);
    const desks = S.batches.get("desk");
    if (desks) writeBatch(desks, performance.now());
  }

  /* ── camera ────────────────────────────────────────────────────────────────────────────────── */

  /** Home framing: a 3/4 view where the whole room (walls included) fits the area beside the sidebar. */
  function homeView() {
    const { w: W, d: D } = S.grid;
    const az = Math.PI / 4.6, pol = 0.93;
    const dir = new THREE.Vector3(Math.sin(pol) * Math.sin(az), Math.cos(pol), Math.sin(pol) * Math.cos(az));
    const corners = [];
    for (const x of [1.5, W - 1.5]) for (const z of [1, D - 1]) for (const y of [0, 1.1]) corners.push(new THREE.Vector3(x, y, z));
    const target = new THREE.Vector3(W / 2, 0, D / 2);
    const cam = camera.clone();
    const pad = 18, free = { l: S.insets.left + pad, r: S.size.w - S.insets.right - pad, t: pad + 10, b: S.size.h - pad - 30 };
    const bounds = (dist) => {
      cam.position.copy(target).addScaledVector(dir, dist);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
      for (const c of corners) {
        const p = c.clone().project(cam);
        const x = (p.x * 0.5 + 0.5) * S.size.w, y = (-p.y * 0.5 + 0.5) * S.size.h;
        l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y);
      }
      return { l, r, t, b };
    };
    let dist = 40;
    for (let pass = 0; pass < 3; pass++) {
      let lo = controls.minDistance, hi = controls.maxDistance;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2, bb = bounds(mid);
        if (bb.r - bb.l <= free.r - free.l && bb.b - bb.t <= free.b - free.t) hi = mid; else lo = mid;
      }
      dist = hi;
      // pan so the room's screen box is centred in the free area
      const bb = bounds(dist);
      const dx = (free.l + free.r) / 2 - (bb.l + bb.r) / 2, dy = (free.t + free.b) / 2 - (bb.t + bb.b) / 2;
      const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const fwd = new THREE.Vector3(-dir.x, 0, -dir.z).normalize();
      const worldPerPx = (2 * dist * Math.tan((cam.fov * Math.PI) / 360)) / S.size.h;
      target.addScaledVector(right, -dx * worldPerPx).addScaledVector(fwd, dy * worldPerPx / Math.cos(pol));
    }
    return { target, pos: target.clone().addScaledVector(dir, dist) };
  }

  function animateTo(target, pos, dur = 750) {
    S.camAnim = { t0: performance.now(), dur, fromT: controls.target.clone(), fromP: camera.position.clone(), toT: target, toP: pos };
  }

  function resetView(animate = true) {
    if (!S.grid) return;
    S.follow = null;
    const v = homeView();
    if (animate) animateTo(v.target, v.pos);
    else { controls.target.copy(v.target); camera.position.copy(v.pos); controls.update(); }
  }

  function zoom(factor) {
    const off = camera.position.clone().sub(controls.target);
    const len = THREE.MathUtils.clamp(off.length() * factor, controls.minDistance, controls.maxDistance);
    animateTo(controls.target.clone(), controls.target.clone().add(off.setLength(len)), 350);
  }

  /** Fly to an agent and keep it centred while it walks; orbit and zoom still work, a pan or unfollow() stops it. */
  function focusAgent(id) {
    const c = S.chars.get(id);
    if (!c) return;
    S.follow = id;
    const t = new THREE.Vector3(c.pos.x, 0.8, c.pos.z);
    const off = camera.position.clone().sub(controls.target);
    off.setLength(Math.max(12, Math.min(off.length(), 19)));
    animateTo(t, t.clone().add(off));
  }

  function stepCam(now) {
    const A = S.camAnim;
    if (!A) return;
    const k = Math.min(1, (now - A.t0) / A.dur), e = easeInOut(k);
    controls.target.lerpVectors(A.fromT, A.toT, e);
    camera.position.lerpVectors(A.fromP, A.toP, e);
    if (k >= 1) S.camAnim = null;
  }

  function clampTarget() {
    if (!S.grid) return;
    const t = controls.target;
    const cx = THREE.MathUtils.clamp(t.x, -1, S.grid.w + 1), cz = THREE.MathUtils.clamp(t.z, -1, S.grid.d + 1), cy = THREE.MathUtils.clamp(t.y, 0, 2);
    if (cx !== t.x || cz !== t.z || cy !== t.y) {
      const d = new THREE.Vector3(cx - t.x, cy - t.y, cz - t.z);
      t.add(d); camera.position.add(d);
    }
  }
  function unfollow() { S.follow = null; }

  // arrow keys / WASD move the camera along the floor, relative to where it looks
  const PAN_KEYS = { ArrowUp: [0, 1], KeyW: [0, 1], ArrowDown: [0, -1], KeyS: [0, -1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
  const held = new Set();
  const typing = (e) => e.target?.closest?.("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey;
  const onKeyDown = (e) => { if (PAN_KEYS[e.code] && !typing(e)) { held.add(e.code); e.preventDefault(); } };
  const onKeyUp = (e) => held.delete(e.code);
  const onBlur = () => held.clear();
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  const keyFwd = new THREE.Vector3(), keyRight = new THREE.Vector3(), keyMove = new THREE.Vector3();
  function stepKeys(dt) {
    if (!held.size) return;
    let x = 0, z = 0;
    for (const k of held) { x += PAN_KEYS[k][0]; z += PAN_KEYS[k][1]; }
    if (!x && !z) return;
    camera.getWorldDirection(keyFwd);
    keyFwd.y = 0;
    keyFwd.normalize();
    keyRight.crossVectors(keyFwd, camera.up).normalize();
    const speed = camera.position.distanceTo(controls.target) * 0.9 * dt;
    keyMove.copy(keyFwd).multiplyScalar(z).addScaledVector(keyRight, x).setLength(speed);
    S.camAnim = null;
    S.follow = null;
    controls.target.add(keyMove);
    camera.position.add(keyMove);
  }

  const followDelta = new THREE.Vector3();
  function stepFollow(dt) {
    if (!S.follow || S.camAnim || S.drag) return;
    const c = S.chars.get(S.follow);
    if (!c || c.leaving) { S.follow = null; return; }
    followDelta.set(c.pos.x - controls.target.x, 0.8 - controls.target.y, c.pos.z - controls.target.z);
    if (followDelta.lengthSq() < 1e-6) return;
    followDelta.multiplyScalar(Math.min(1, dt * 6));
    controls.target.add(followDelta);
    camera.position.add(followDelta);
  }

  controls.addEventListener("start", () => { S.camAnim = null; S.drag = controls.target.clone(); });
  controls.addEventListener("end", () => {
    if (S.drag && S.drag.distanceTo(controls.target) > 0.05) S.follow = null; // the user panned away
    S.drag = null;
  });

  /* ── picking ───────────────────────────────────────────────────────────────────────────────── */

  const ndc = new THREE.Vector2();
  function setRay(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    S.raycaster.setFromCamera(ndc, camera);
  }

  function floorAt(clientX, clientY) {
    setRay(clientX, clientY);
    const ray = S.raycaster.ray;
    if (Math.abs(ray.direction.y) < 1e-4) return null;
    const t = -ray.origin.y / ray.direction.y;
    if (t < 0) return null;
    return { x: ray.origin.x + ray.direction.x * t, z: ray.origin.z + ray.direction.z * t };
  }

  function pickAt(clientX, clientY, { items = true, agents = true } = {}) {
    setRay(clientX, clientY);
    const targets = [];
    if (agents) for (const c of S.chars.values()) if (!c.leaving) targets.push(c.hit);
    if (items) for (const b of S.batches.values()) for (const m of b.meshes) if (m.visible && m.parent?.visible !== false && m.userData.role !== "glow") targets.push(m);
    if (items) for (const t of S.texts.values()) if (t.parent?.visible !== false) targets.push(t);
    const hits = S.raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      if (h.object.userData.agentId) return { type: "agent", id: h.object.userData.agentId };
      if (h.object.userData.itemId) return { type: "item", id: h.object.userData.itemId };
      if (h.object.isInstancedMesh && h.instanceId != null) {
        const b = S.batches.get(h.object.userData.key);
        const inst = b?.insts[h.instanceId];
        if (inst && !S.leavingItems.has(inst.id)) return { type: "item", id: inst.id };
      }
    }
    const f = floorAt(clientX, clientY);
    if (f && S.grid && f.x >= 0 && f.z >= 0 && f.x < S.grid.w && f.z < S.grid.d) return { type: "floor", ...f };
    return null;
  }

  /* ── edit ghost & selection ────────────────────────────────────────────────────────────────── */

  const outlineGeo = new THREE.PlaneGeometry(1, 1);
  const outline = new THREE.Mesh(outlineGeo, mats.outline);
  outline.rotation.x = -Math.PI / 2;
  outline.visible = false;
  outline.renderOrder = 2;
  scene.add(outline);

  function showFootprint(f, color) {
    if (!f) { outline.visible = false; return; }
    outline.visible = true;
    outline.scale.set(f.w, f.d, 1);
    outline.position.set(f.x + f.w / 2, 0.03, f.z + f.d / 2);
    mats.outline.color.set(color);
  }

  /** ghost: {kind, x, z, rot, valid} | null — a translucent copy of the kind at that cell. */
  function setGhost(g) {
    if (S.ghost && (!g || S.ghost.userData.kind !== g.kind)) { scene.remove(S.ghost); S.ghost = null; }
    if (!g) { showFootprint(S.selectedItem ? footprint(S.selectedItem, S.custom) : null, "#ffe066"); return; }
    if (!S.ghost) {
      const a = assetsFor(g.kind);
      const grp = new THREE.Group();
      for (const part of a.parts) grp.add(new THREE.Mesh(part.geo, mats.ghost));
      grp.userData.kind = g.kind;
      scene.add(grp);
      S.ghost = grp;
    }
    const f = footprint(g, S.custom);
    S.ghost.position.set(f.x + f.w / 2, 0.02, f.z + f.d / 2);
    S.ghost.rotation.y = (g.rot * Math.PI) / 180;
    mats.ghost.color.set(g.valid ? "#7dffb0" : "#ff6b6b");
    showFootprint(f, g.valid ? "#7dffb0" : "#ff6b6b");
  }

  function selectItem(item) {
    S.selectedItem = item;
    showFootprint(item ? footprint(item, S.custom) : null, "#ffe066");
  }

  /** Hide items (e.g. the one being moved) from the instanced batches. */
  function hideItems(ids) {
    S.hidden = new Set(ids);
    const now = performance.now();
    for (const b of S.batches.values()) writeBatch(b, now);
    for (const [id, t] of S.texts) t.visible = !S.hidden.has(id);
  }

  /** Render one kind to a data URL for the edit palette. */
  function thumbnail(kind, size = 96) {
    const a = assetsFor(kind);
    const ts = new THREE.Scene();
    ts.add(new THREE.HemisphereLight("#ffffff", "#c9b8a0", 2.2));
    const dl = new THREE.DirectionalLight("#fff1dc", 2.4);
    dl.position.set(-2, 4, 3);
    ts.add(dl);
    const g = new THREE.Group();
    for (const part of a.parts) {
      let m = part.mat;
      if (part.role === "accent") { m = part.mat.clone(); m.color.copy(S.kindColor.get(kind) ?? a.defaultColor); }
      g.add(new THREE.Mesh(part.geo, m));
    }
    ts.add(g);
    const box = new THREE.Box3().setFromObject(g);
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.6);
    const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    cam.position.copy(c).add(new THREE.Vector3(1, 0.85, 1.25).normalize().multiplyScalar(r / Math.tan((14 * Math.PI) / 180) * 1.02));
    cam.lookAt(c);
    const rt = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const prevTone = renderer.toneMapping;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(ts, cam);
    const px = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
    renderer.setRenderTarget(null);
    renderer.toneMapping = prevTone;
    rt.dispose();
    for (const m of g.children) if (!a.parts.some((p) => p.mat === m.material)) m.material.dispose();
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) img.data.set(px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL();
  }

  /* ── loop ──────────────────────────────────────────────────────────────────────────────────── */

  function resize() {
    const r = container.getBoundingClientRect();
    S.size = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    renderer.setSize(S.size.w, S.size.h, false);
    composer.setSize(S.size.w, S.size.h);
    composer.setPixelRatio(renderer.getPixelRatio());
    camera.aspect = S.size.w / S.size.h;
    applyInsets();
  }
  /** Shift the projection centre into the area not covered by the sidebar / chat panel. */
  function applyInsets() {
    const dx = (S.insets.left - S.insets.right) / 2;
    if (dx) camera.setViewOffset(S.size.w, S.size.h, -dx, 0, S.size.w, S.size.h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  const proj = new THREE.Vector3();
  function anchors() {
    const out = [];
    for (const c of S.chars.values()) {
      const seated = SEATED.has(c.pose) || c.pose === "sit";
      const y = (seated ? (c.target?.seatY ?? SEAT_Y) - 0.4 + CROWN : CROWN) * c.obj.scale.y;
      proj.set(c.pos.x, y + 0.05, c.pos.z).project(camera);
      const visible = proj.z < 1 && proj.z > -1;
      out.push({
        id: c.id, x: (proj.x * 0.5 + 0.5) * S.size.w, y: (-proj.y * 0.5 + 0.5) * S.size.h,
        depth: camera.position.distanceTo(c.obj.position), visible, leaving: c.leaving, scale: c.obj.scale.x,
      });
    }
    return out;
  }

  function frame() {
    S.raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - S.last) / 1000);
    S.last = now;
    S.clock += dt;
    stepCam(now);
    stepKeys(dt);
    stepFollow(dt);
    controls.update();
    clampTarget();
    updateCutaway();

    // fog follows zoom so the garden softly fades, the office never does
    const dist = camera.position.distanceTo(controls.target);
    scene.fog.near = dist * 1.5;
    scene.fog.far = dist * 4.5;

    // item pop animations
    let animating = false;
    for (const [id, a] of S.itemAnim) {
      if (now - a.t0 > POP_MS) {
        S.itemAnim.delete(id);
        if (a.kind === "out") { S.leavingItems.delete(id); animating = "rebuild"; }
        else if (!animating) animating = true;
      } else if (!animating) animating = true;
    }
    const fading = stepFade(now);
    if (animating === "rebuild") rebuildFurniture();
    else if (animating || fading) for (const b of S.batches.values()) writeBatch(b, now);

    for (const c of [...S.chars.values()]) {
      if (!stepChar(c, dt, now)) {
        scene.remove(c.obj);
        c.obj.userData.dispose();
        c.hit.geometry.dispose(); c.hit.material.dispose(); c.blob.geometry.dispose();
        S.chars.delete(c.id);
      }
    }
    composer.render(dt);
    for (const cb of S.frameCbs) cb(now);
  }
  paintPalette(paletteFor(S.look));
  setTheme("day");
  frame();

  return {
    setInsets(left, right) { S.insets = { left, right }; applyInsets(); },
    setState, setTheme, resetView, zoom, focusAgent, unfollow, anchors, pickAt, floorAt, setGhost, selectItem, hideItems, thumbnail,
    /** Where everyone is and what they're doing (for ?debug and tests in the browser). */
    debug() {
      return [...S.chars.values()].map((c) => ({ id: c.id, pose: c.pose, spot: c.spotId, walking: c.path.length > 0, x: +c.pos.x.toFixed(2), z: +c.pos.z.toFixed(2) }));
    },
    /** Frame a point of the floor (x, z) from the current angle at distance `dist`. */
    lookAt(x, z, dist = 12, animate = true) {
      const t = new THREE.Vector3(x, 0.6, z);
      const off = camera.position.clone().sub(controls.target).setLength(dist);
      if (animate) animateTo(t, t.clone().add(off));
      else { S.camAnim = null; controls.target.copy(t); camera.position.copy(t.clone().add(off)); controls.update(); }
    },
    /** Run the characters forward `seconds` without waiting for frames (background tabs barely animate). */
    advance(seconds) {
      for (let k = 0; k < seconds / 0.05; k++) {
        S.clock += 0.05;
        for (const c of S.chars.values()) stepChar(c, 0.05, performance.now());
      }
      controls.update();
      updateCutaway();
      for (const c of S.chars.values()) stepChar(c, 0, performance.now());
      composer.render(0);
      for (const cb of S.frameCbs) cb(performance.now());
    },
    get theme() { return S.theme; },
    get grid() { return S.grid; },
    onFrame(cb) { S.frameCbs.push(cb); },
    canvas: renderer.domElement,
    controls,
    dispose() {
      cancelAnimationFrame(S.raf);
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
