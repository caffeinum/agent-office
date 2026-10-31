// The city stage: renderer (WebGL2, DPR ≤ 1.25, drops to 1.0 under 45 fps), composer + bloom, hemi + sun with a
// target-following shadow box, day/night THEMES, sky + fog, map-style OrbitControls, WASD, touch (one-finger pan,
// pinch zoom, twist rotate, two-finger vertical drag tilts) and the rAF loop. Duplicated from the office
// scene.js on purpose (spec §3); extracting a shared stage is phase-2 debt.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { skyTexture } from "../textures.js";

export const DPR_MAX = 1.25;
export const DPR_LOW = 1.0;
export const FPS_FLOOR = 45;
export const SHADOW_HALF = 128;
export const SHADOW_MAP = 2048;
export const CAMERA = { fov: 30, near: 1, far: 6000, minPolar: 0.32, maxPolar: 1.2, minDist: 30, maxDist: 2500 };

export const THEMES = {
  day: { hemiSky: "#d7ecff", hemiGround: "#e3c39d", hemi: 1.25, sun: 2.7, sunColor: "#ffe4bd", fog: "#e8eef2", bloom: 0.22, threshold: 0.95, exposure: 1.0, windows: 0 },
  night: { hemiSky: "#41508f", hemiGround: "#2b2236", hemi: 0.45, sun: 0.3, sunColor: "#9fb3ff", fog: "#1d2147", bloom: 0.85, threshold: 0.6, exposure: 1.05, windows: 1 },
};

const SUN_DIR = new THREE.Vector3(-0.55, 1, 0.75).normalize();
const SUN_DIST = 900;
const PAN_KEYS = { ArrowUp: [0, 1], KeyW: [0, 1], ArrowDown: [0, -1], KeyS: [0, -1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };

/** → {THREE, renderer, scene, camera, controls, composer, sun, theme, setTheme(name), onFrame(fn), dispose()} */
export function createStage(container, { theme = "day" } = {}) {
  const probe = document.createElement("canvas");
  if (!probe.getContext("webgl2")) throw new Error("this browser has no WebGL2 (disabled, or no GPU) — the city needs it.");

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
  let dpr = Math.min(window.devicePixelRatio || 1, DPR_MAX);
  renderer.setPixelRatio(dpr);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = false;
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minPolarAngle = CAMERA.minPolar;
  controls.maxPolarAngle = CAMERA.maxPolar;
  controls.minDistance = CAMERA.minDist;
  controls.maxDistance = CAMERA.maxDist;
  controls.screenSpacePanning = false;
  controls.zoomSpeed = 0.9;
  controls.rotateSpeed = 0.6;
  // map-style: drag pans, right-drag orbits; one finger pans, two fingers are ours (pinch, twist, tilt)
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: null };

  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.3, 0.55, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const hemi = new THREE.HemisphereLight("#d7ecff", "#e3c39d", 1.2);
  const sun = new THREE.DirectionalLight("#ffe4bd", 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.05;
  const sc = sun.shadow.camera;
  sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF;
  sc.near = 1; sc.far = SUN_DIST * 2;
  sc.updateProjectionMatrix();
  scene.add(hemi, sun, sun.target);
  scene.fog = new THREE.Fog("#e8eef2", 300, 1800);
  const sky = { day: skyTexture(false), night: skyTexture(true) };

  // shadow box snapped to shadow-map texels along the light's own axes, so panning never shimmers
  const texel = (SHADOW_HALF * 2) / SHADOW_MAP;
  const lightRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
  const lightUp = new THREE.Vector3().crossVectors(SUN_DIR, lightRight).normalize();
  const snapped = new THREE.Vector3();
  function placeSun() {
    const t = controls.target;
    const a = t.dot(lightRight), b = t.dot(lightUp);
    snapped.copy(t)
      .addScaledVector(lightRight, Math.round(a / texel) * texel - a)
      .addScaledVector(lightUp, Math.round(b / texel) * texel - b);
    sun.target.position.copy(snapped);
    sun.position.copy(snapped).addScaledVector(SUN_DIR, SUN_DIST);
  }

  const state = { theme: null, frameCbs: [], themeCbs: [], moveCbs: [], raf: 0, last: performance.now(), size: { w: 1, h: 1 } };

  function setTheme(name) {
    const th = THEMES[name];
    if (!th) throw new Error(`unknown city theme "${name}" (day | night)`);
    state.theme = name;
    hemi.color.set(th.hemiSky);
    hemi.groundColor.set(th.hemiGround);
    hemi.intensity = th.hemi;
    sun.color.set(th.sunColor);
    sun.intensity = th.sun;
    scene.background = sky[name];
    scene.fog.color.set(th.fog);
    bloom.strength = th.bloom;
    bloom.threshold = th.threshold;
    renderer.toneMappingExposure = th.exposure;
    for (const fn of state.themeCbs) fn(name, th);
  }

  /* ── WASD / arrows: move along the ground, relative to where the camera looks ────────────────── */
  const held = new Set();
  const typing = (e) => e.target?.closest?.("input, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey;
  const onKeyDown = (e) => { if (PAN_KEYS[e.code] && !typing(e)) { held.add(e.code); e.preventDefault(); } };
  const onKeyUp = (e) => held.delete(e.code);
  const onBlur = () => held.clear();
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3();
  function stepKeys(dt) {
    if (!held.size) return false;
    let x = 0, z = 0;
    for (const k of held) { x += PAN_KEYS[k][0]; z += PAN_KEYS[k][1]; }
    if (!x && !z) return false;
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    right.crossVectors(fwd, camera.up).normalize();
    move.copy(fwd).multiplyScalar(z).addScaledVector(right, x).setLength(camera.position.distanceTo(controls.target) * 0.9 * dt);
    controls.target.add(move);
    camera.position.add(move);
    return true;
  }

  /* ── two-finger touch: pinch zooms, twist rotates, vertical drag of both fingers tilts ───────── */
  const touches = new Map();
  let pair = null;
  const offset = new THREE.Vector3(), sph = new THREE.Spherical();
  const pairState = () => {
    const [a, b] = [...touches.values()];
    return { dist: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x), midY: (a.y + b.y) / 2 };
  };
  const onPointerDown = (e) => {
    if (e.pointerType !== "touch") return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pair = touches.size === 2 ? pairState() : null;
  };
  const onPointerMove = (e) => {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size !== 2 || !pair) return;
    const now = pairState();
    offset.copy(camera.position).sub(controls.target);
    sph.setFromVector3(offset);
    if (now.dist > 1 && pair.dist > 1) sph.radius *= pair.dist / now.dist;
    sph.theta -= Math.atan2(Math.sin(now.angle - pair.angle), Math.cos(now.angle - pair.angle));
    sph.phi -= ((now.midY - pair.midY) / state.size.h) * Math.PI * 0.8;
    sph.phi = THREE.MathUtils.clamp(sph.phi, CAMERA.minPolar, CAMERA.maxPolar);
    sph.radius = THREE.MathUtils.clamp(sph.radius, CAMERA.minDist, CAMERA.maxDist);
    offset.setFromSpherical(sph);
    camera.position.copy(controls.target).add(offset);
    camera.lookAt(controls.target);
    pair = now;
    for (const fn of state.moveCbs) fn();
  };
  const onPointerUp = (e) => {
    touches.delete(e.pointerId);
    pair = touches.size === 2 ? pairState() : null;
  };
  const el = renderer.domElement;
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerUp);

  /* ── loop ─────────────────────────────────────────────────────────────────────────────────── */
  function resize() {
    const r = container.getBoundingClientRect();
    state.size = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    renderer.setSize(state.size.w, state.size.h, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(state.size.w, state.size.h);
    camera.aspect = state.size.w / state.size.h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // adaptive DPR: two slow seconds in a row (after a 3 s warm-up) drop the pixel ratio to 1.0, once
  const perf = { frames: 0, t0: performance.now(), fps: 0, slow: 0, start: performance.now() };
  function trackFps(now) {
    perf.frames++;
    if (now - perf.t0 < 1000) return;
    perf.fps = (perf.frames * 1000) / (now - perf.t0);
    perf.frames = 0;
    perf.t0 = now;
    if (dpr <= DPR_LOW || now - perf.start < 3000 || document.hidden) return;
    perf.slow = perf.fps < FPS_FLOOR ? perf.slow + 1 : 0;
    if (perf.slow >= 2) {
      dpr = DPR_LOW;
      renderer.setPixelRatio(dpr);
      resize();
      console.info(`city: ${perf.fps.toFixed(0)} fps, pixel ratio lowered to ${dpr}`);
    }
  }

  const frameInfo = { calls: 0, tris: 0 };
  function frame() {
    state.raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - state.last) / 1000);
    state.last = now;
    renderer.info.reset();
    const keyed = stepKeys(dt);
    controls.update(dt);
    for (const fn of state.frameCbs) fn(now, dt, keyed);
    placeSun();
    composer.render(dt);
    frameInfo.calls = renderer.info.render.calls;
    frameInfo.tris = renderer.info.render.triangles;
    trackFps(now);
  }

  setTheme(theme);
  frame();

  return {
    THREE, renderer, scene, camera, controls, composer, sun,
    get theme() { return state.theme; },
    get size() { return state.size; },
    get pixelRatio() { return dpr; },
    setTheme,
    /** fn(name, themeValues) after every theme change. */
    onTheme(fn) { state.themeCbs.push(fn); },
    /** fn(now, dt, keyed) every frame, after the controls update and before rendering. */
    onFrame(fn) { state.frameCbs.push(fn); },
    /** fn() when the two-finger gesture moves the camera (OrbitControls fires its own "change" for the rest). */
    onGesture(fn) { state.moveCbs.push(fn); },
    /** fps over the last second, and draw calls / triangles of the last frame including shadow and composer passes. */
    stats: () => ({ fps: Math.round(perf.fps * 10) / 10, calls: frameInfo.calls, tris: frameInfo.tris }),
    dispose() {
      cancelAnimationFrame(state.raf);
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      controls.dispose();
      composer.dispose();
      renderer.dispose();
      el.remove();
    },
  };
}
