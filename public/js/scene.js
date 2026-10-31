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
import {
  SEATED, blockedCells, deskSeating, entryPoint, hashStr, idleSpots, layoutBatches, limbAngles, pickSpot, poseFor, route, seatOf,
} from "./model.js";
import { MODELS, SEAT_Y, WALL_H } from "./furniture.js";
import { buildGeometry, vbox } from "./voxel.js";
import { CROWN, applyLimbs, awayMaterial, baseMaterial, blink, buildCharacter } from "./character.js";
import * as T from "./textures.js";

const WALK_SPEED = 1.7;
const POP_MS = 420;
const BORDER = 2.5;
const SPOT_SEAT_Y = { sofa: 0.48, beanbag: 0.4, chair: SEAT_Y };
const THEMES = {
  day: { hemiSky: "#d7ecff", hemiGround: "#e3c39d", hemi: 1.25, sun: 2.7, sunColor: "#ffe4bd", fog: "#e8eef2", bloom: 0.28, threshold: 0.92, glow: 1.0, lamp: 0.95, point: 0, exposure: 1.0 },
  night: { hemiSky: "#41508f", hemiGround: "#2b2236", hemi: 0.5, sun: 0.35, sunColor: "#9fb3ff", fog: "#1d2147", bloom: 0.7, threshold: 0.72, glow: 1.2, lamp: 2.4, point: 9, exposure: 1.05 },
};

const easeOutBack = (t) => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export function createScene(container) {
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
    windowDay: T.windowTexture(false), windowNight: T.windowTexture(true), skyDay: T.skyTexture(false), skyNight: T.skyTexture(true), blob: T.blobTexture(),
  };
  const mats = {
    base: new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.grain, roughness: 0.86, metalness: 0 }),
    accent: new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.grain, roughness: 0.82, metalness: 0 }),
    rug: new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.rug, roughness: 1 }),
    ghost: new THREE.MeshBasicMaterial({ color: "#7dffb0", transparent: true, opacity: 0.45, depthWrite: false }),
    blob: new THREE.MeshBasicMaterial({ map: tex.blob, transparent: true, depthWrite: false }),
    outline: new THREE.MeshBasicMaterial({ color: "#ffe066", transparent: true, opacity: 0.35, depthWrite: false }),
  };
  const charBase = baseMaterial(tex.grain);
  const charAway = awayMaterial(tex.grain);

  const S = {
    theme: "day", grid: null, items: [], agents: [], seating: new Map(), spots: [], blocked: null, entry: { x: 0, z: 0 },
    room: null, walls: {}, furniture: new THREE.Group(), batches: new Map(), texts: new Map(), itemAnim: new Map(), leavingItems: new Map(),
    chars: new Map(), lampLights: [], glowMats: new Map(), selectedItem: null, ghost: null, hidden: new Set(),
    camAnim: null, insets: { left: 0, right: 0 }, clock: 0, last: performance.now(), size: { w: 1, h: 1 }, frameCbs: [], raf: 0, raycaster: new THREE.Raycaster(),
  };
  scene.add(S.furniture);

  /* ── kind assets ───────────────────────────────────────────────────────────────────────────── */

  const kindAssets = new Map();
  function assetsFor(kind) {
    if (kindAssets.has(kind)) return kindAssets.get(kind);
    const m = MODELS[kind]();
    const a = {
      model: m,
      base: m.base.length ? buildGeometry(m.base) : null,
      accent: m.accent.length ? buildGeometry(m.accent) : null,
      glow: m.glow ? buildGeometry(m.glow.boxes, { ao: false }) : null,
      glowMat: null,
      defaultColor: new THREE.Color(m.defaultColor),
    };
    if (m.glow) {
      const map = m.glow.tex === "window" ? tex.windowDay : m.glow.tex ? tex[m.glow.tex] : null;
      a.glowMat = new THREE.MeshBasicMaterial({ map, color: m.glow.color ?? "#ffffff", toneMapped: true });
      a.glowMat.userData = { baseColor: new THREE.Color(m.glow.color ?? "#ffffff"), lamp: !!m.glow.lamp, window: m.glow.tex === "window" };
      S.glowMats.set(kind, a.glowMat);
    }
    kindAssets.set(kind, a);
    return a;
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

    // floor
    const wood = tex.wood.clone();
    wood.needsUpdate = true;
    wood.repeat.set(W, D);
    const floorMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.78 });
    const floor = own(new THREE.Mesh(new THREE.PlaneGeometry(W, D), floorMat));
    floor.userData.ownMat = true;
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

    // walls: full + low stub each, the camera-side ones swap to the stub (cutaway)
    const wallBoxes = (len, doorAt) => {
      const segs = doorAt == null ? [[0, len]] : [[0, doorAt - 1], [doorAt + 1, len]];
      const full = [], stub = [];
      for (const [a, b] of segs) {
        const L = b - a, c = (a + b) / 2;
        full.push(vbox(c, 0, -0.12, L, WALL_H, 0.24, "#f3e6cf"));
        full.push(vbox(c, WALL_H, -0.12, L + 0.02, 0.1, 0.3, "#b98a5e"));
        full.push(vbox(c, 0, 0.015, L, 0.14, 0.03, "#e1cfb2"));
        stub.push(vbox(c, 0, -0.12, L, 0.32, 0.24, "#f3e6cf"));
        stub.push(vbox(c, 0.32, -0.12, L + 0.02, 0.06, 0.3, "#b98a5e"));
      }
      if (doorAt != null) full.push(vbox(doorAt, 2.1, -0.12, 2, WALL_H - 2.1, 0.24, "#f3e6cf"));
      return { full, stub };
    };
    const plasterMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: tex.plaster, roughness: 0.95 });
    const mkWall = (len, doorAt) => {
      const wb = wallBoxes(len, doorAt);
      const grp = new THREE.Group();
      const full = new THREE.Group();
      const fm = own(new THREE.Mesh(buildGeometry(wb.full), plasterMat));
      fm.castShadow = true; fm.receiveShadow = true;
      full.add(fm);
      const stub = own(new THREE.Mesh(buildGeometry(wb.stub), plasterMat));
      stub.receiveShadow = true;
      stub.visible = false;
      grp.add(full, stub);
      return { grp, full, stub };
    };
    const back = mkWall(W); // along +x at z = 0, inner face +z
    const front = mkWall(W, W / 2);
    front.grp.rotation.y = Math.PI; front.grp.position.set(W, 0, D);
    const left = mkWall(D); // along +z at x = 0, inner face +x
    left.grp.rotation.y = Math.PI / 2; left.grp.position.set(0, 0, D);
    const right = mkWall(D);
    right.grp.rotation.y = -Math.PI / 2; right.grp.position.set(W, 0, 0);
    // corner posts
    const posts = [];
    for (const [x, z] of [[0, 0], [W, 0], [0, D], [W, D]]) posts.push(vbox(x, 0, z, 0.3, WALL_H + 0.12, 0.3, "#b98a5e"));
    const postMesh = own(new THREE.Mesh(buildGeometry(posts), mats.base));
    postMesh.castShadow = true;
    g.add(back.grp, front.grp, left.grp, right.grp, postMesh);
    S.walls = { back, front, left, right, posts: postMesh };
    plasterMat.userData.shared = true;
    g.userData.plaster = plasterMat;

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
    const all = [...S.items, ...S.leavingItems.values()];
    const { batches, texts } = layoutBatches(all);
    for (const [key, insts] of batches) {
      const kind = insts[0].kind;
      const a = assetsFor(kind);
      const parent = insts[0].wall ? S.walls[insts[0].wall].full : S.furniture;
      const meshes = [];
      const mk = (geo, mat, role) => {
        const im = new THREE.InstancedMesh(geo, mat, insts.length);
        im.castShadow = !a.model.noShadow && role !== "glow";
        im.receiveShadow = role !== "glow";
        im.userData.role = role;
        im.userData.key = key;
        im.frustumCulled = false;
        parent.add(im);
        meshes.push(im);
        return im;
      };
      if (a.base) mk(a.base, mats.base, "base");
      if (a.accent) mk(a.accent, a.model.accentMap === "rug" ? mats.rug : mats.accent, "accent");
      if (a.glow) mk(a.glow, a.glowMat, "glow");
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
          m.setColorAt(i, tmpC.set(inst.color ?? assetsFor(batch.kind).defaultColor));
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
      if (!ag) return 0.08;
      return ag.status === "working" ? 1 : ag.status === "away" ? 0.12 : 0.5;
    }
    return 0.08;
  }

  function syncTexts(texts) {
    const want = new Map(texts.map((t) => [t.id, t]));
    for (const [id, o] of S.texts) {
      const t = want.get(id);
      if (!t || o.userData.sig !== `${t.text}|${t.color}|${t.x}|${t.z}|${t.yaw}`) {
        o.parent?.remove(o);
        o.geometry.dispose(); o.material.map.dispose(); o.material.dispose();
        S.texts.delete(id);
      }
    }
    for (const t of texts) {
      if (S.texts.has(t.id)) continue;
      const spec = assetsFor(t.kind).model.text;
      if (!spec) throw new Error(`textable kind ${t.kind} has no text panel in its model`);
      const map = T.textTexture(t.text, { bg: spec.bg, fg: spec.fg, w: spec.tw, h: spec.th });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.w, spec.h), new THREE.MeshStandardMaterial({ map, roughness: 0.9 }));
      mesh.userData.sig = `${t.text}|${t.color}|${t.x}|${t.z}|${t.yaw}`;
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
    const lamps = S.items.filter((it) => it.kind === "lamp" || it.kind === "tv").slice(0, 6);
    for (const it of lamps) {
      const f = footprint(it);
      const pl = new THREE.PointLight(it.kind === "lamp" ? "#ffc27a" : "#8fb6ff", th.point * (it.kind === "lamp" ? 1 : 0.4), 7, 1.6);
      pl.position.set(f.x + f.w / 2, it.kind === "lamp" ? 1.4 : 1.0, f.z + f.d / 2);
      pl.visible = th.point > 0;
      scene.add(pl);
      S.lampLights.push(pl);
    }
    // a soft warm "ceiling" fill at night so the room isn't a cave
    // a crowded floor (lots of desks) swallows light, so the fill grows with the furniture count
    const density = Math.min(1, S.items.filter((it) => kindOf(it.kind)?.layer === "object").length / (S.grid.w * S.grid.d * 0.12));
    const fill = new THREE.PointLight("#ffd9a8", th.point * (2.2 + 1.6 * density), Math.hypot(S.grid.w, S.grid.d), 1.2);
    fill.position.set(S.grid.w / 2, 4.5, S.grid.d / 2);
    fill.visible = th.point > 0;
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
    const start = initial ? targetFor(agent, new Set()).at : S.entry;
    const c = {
      id: agent.id, agent, obj, hit, blob, pos: { x: start.x, z: start.z }, yaw: initial ? targetFor(agent, new Set()).yaw : Math.PI,
      path: [], target: null, pose: "stand", phase: (hashStr(agent.id) % 1000) / 100, pop: { kind: "in", t0: now }, leaving: false,
      seatY: SEAT_Y, nextWander: now + 15000 + Math.random() * 20000, salt: 0, spotId: null, away: false, waveUntil: initial ? 0 : now + 2200,
    };
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

  /** Where an agent should go, given everyone else's taken spots. */
  function targetFor(agent, taken, salt = 0) {
    const desk = S.seating.get(agent.id);
    const { pose, place } = poseFor(agent, !!desk);
    if (place === "desk" && desk) {
      const s = seatOf(desk);
      return { key: `desk:${desk.id}`, at: { x: s.x, z: s.z }, yaw: s.yaw, pose, seatY: SEAT_Y };
    }
    const spot = pickSpot(agent.id, S.spots, taken, salt);
    if (spot) {
      const item = S.items.find((i) => i.id === spot.itemId);
      const sitPose = spot.pose === "sit" ? "sit" : spot.pose;
      return { key: `spot:${spot.id}`, spotId: spot.id, at: { x: spot.x, z: spot.z }, yaw: spot.yaw, pose: pose === "wave" ? "wave" : sitPose, seatY: SPOT_SEAT_Y[item?.kind] ?? SEAT_Y };
    }
    // nowhere to sit: mill about near the entrance, spread out by id
    const h = hashStr(agent.id + salt);
    return { key: `mill:${h % 97}`, at: { x: S.entry.x + ((h % 5) - 2) * 0.9, z: Math.max(0.5, S.entry.z - 1 - ((h >> 3) % 3) * 0.9) }, yaw: Math.PI, pose: pose === "wave" ? "wave" : "stand", seatY: SEAT_Y };
  }

  function retarget() {
    const taken = new Set();
    // desk agents first, then lounge agents in join order: stable assignments
    const order = [...S.chars.values()].filter((c) => !c.leaving).sort((a, b) => a.agent.joinedAt - b.agent.joinedAt);
    for (const c of order) {
      const t = targetFor(c.agent, taken, c.salt);
      if (t.spotId) taken.add(t.spotId);
      if (!c.target || c.target.key !== t.key) {
        c.target = t;
        c.path = route(S.blocked, S.grid, c.pos, t.at);
      } else {
        c.target = { ...c.target, pose: t.pose, yaw: t.yaw };
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
      if (c.agent.status === "idle" && now > c.nextWander && !c.leaving) {
        c.salt++;
        c.nextWander = now + 25000 + Math.random() * 30000;
        c.target = null;
        retarget();
      }
    } else pose = "stand";
    if (c.leaving) pose = "wave";
    c.pose = pose;
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
    // items: diff for pop animations
    const prev = new Map(S.items.map((i) => [i.id, i]));
    const next = new Map(state.items.map((i) => [i.id, i]));
    let itemsChanged = gridChanged || prev.size !== next.size;
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
      S.blocked = blockedCells(S.items, S.grid);
      S.spots = idleSpots(S.items);
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
  }

  /* ── theme ─────────────────────────────────────────────────────────────────────────────────── */

  function setTheme(theme) {
    if (!THEMES[theme]) throw new Error(`unknown theme ${theme}`);
    S.theme = theme;
    const th = THEMES[theme];
    hemi.color.set(th.hemiSky); hemi.groundColor.set(th.hemiGround); hemi.intensity = th.hemi;
    sun.color.set(th.sunColor); sun.intensity = th.sun;
    scene.background = theme === "night" ? tex.skyNight : tex.skyDay;
    scene.fog.color.set(th.fog);
    bloom.strength = th.bloom; bloom.threshold = th.threshold;
    renderer.toneMappingExposure = th.exposure;
    for (const m of S.glowMats.values()) {
      const k = m.userData.lamp ? th.lamp : th.glow;
      m.color.copy(m.userData.baseColor).multiplyScalar(k);
      if (m.userData.window) { m.map = theme === "night" ? tex.windowNight : tex.windowDay; m.color.setScalar(theme === "night" ? 0.95 : 1.05); m.needsUpdate = true; }
    }
    if (S.grid) updateLampLights();
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
    const v = homeView();
    if (animate) animateTo(v.target, v.pos);
    else { controls.target.copy(v.target); camera.position.copy(v.pos); controls.update(); }
  }

  function zoom(factor) {
    const off = camera.position.clone().sub(controls.target);
    const len = THREE.MathUtils.clamp(off.length() * factor, controls.minDistance, controls.maxDistance);
    animateTo(controls.target.clone(), controls.target.clone().add(off.setLength(len)), 350);
  }

  function focusAgent(id) {
    const c = S.chars.get(id);
    if (!c) return;
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
  controls.addEventListener("start", () => { S.camAnim = null; });

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
    if (!g) { showFootprint(S.selectedItem ? footprint(S.selectedItem) : null, "#ffe066"); return; }
    if (!S.ghost) {
      const a = assetsFor(g.kind);
      const grp = new THREE.Group();
      for (const geo of [a.base, a.accent, a.glow]) if (geo) grp.add(new THREE.Mesh(geo, mats.ghost));
      grp.userData.kind = g.kind;
      scene.add(grp);
      S.ghost = grp;
    }
    const f = footprint(g);
    S.ghost.position.set(f.x + f.w / 2, 0.02, f.z + f.d / 2);
    S.ghost.rotation.y = (g.rot * Math.PI) / 180;
    mats.ghost.color.set(g.valid ? "#7dffb0" : "#ff6b6b");
    showFootprint(f, g.valid ? "#7dffb0" : "#ff6b6b");
  }

  function selectItem(item) {
    S.selectedItem = item;
    showFootprint(item ? footprint(item) : null, "#ffe066");
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
    for (const [geo, role] of [[a.base, "base"], [a.accent, "accent"], [a.glow, "glow"]]) {
      if (!geo) continue;
      const m = role === "glow" ? a.glowMat : role === "accent" ? (a.model.accentMap === "rug" ? mats.rug : mats.accent).clone() : mats.base;
      if (role === "accent") m.color.copy(a.defaultColor);
      g.add(new THREE.Mesh(geo, m));
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
    for (const m of g.children) if (m.material !== mats.base && m.material !== a.glowMat) m.material.dispose();
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
    if (animating === "rebuild") rebuildFurniture();
    else if (animating) for (const b of S.batches.values()) writeBatch(b, now);

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
  setTheme("day");
  frame();

  return {
    setInsets(left, right) { S.insets = { left, right }; applyInsets(); },
    setState, setTheme, resetView, zoom, focusAgent, anchors, pickAt, floorAt, setGhost, selectItem, hideItems, thumbnail,
    get theme() { return S.theme; },
    get grid() { return S.grid; },
    onFrame(cb) { S.frameCbs.push(cb); },
    canvas: renderer.domElement,
    controls,
    dispose() {
      cancelAnimationFrame(S.raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
