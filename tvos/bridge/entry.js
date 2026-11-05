// The Apple TV viewer's brain, run in JavaScriptCore: the web viewer's own pure modules decide furniture shapes,
// desk seating, idle spots and wandering, so the TV places everything exactly where a browser would. Swift feeds
// it the office WebSocket frames and draws what scene() returns.
import { MODELS, SEAT_Y, WALL_H } from "../../public/js/furniture.js";
import {
  applyFrame, assignSpots, deskSeating, entryPoint, hashStr, idleSpots, itemPoint, kindGeometryPlan, layoutBatches, poseFor, seatOf,
  usableSpots, wanderSalt, limbAngles, route, cullLabels, labelPriority, placedLights,
} from "../../public/js/model.js";
import { blockedCells } from "../../public/shared/kinds.js";
import { kindOf } from "../../public/shared/catalog.js";
import { characterRig } from "../../public/js/character.js";
import { GARDEN_BORDER, cornerPosts, gardenBoxes, roomWalls, wallBoxes } from "../../public/js/room.js";
import { floorTexture, grainTexture, grassTexture, nightWindowTexture, plinthTexture, rackTexture, rugTexture, screenOffTexture, screenTexture, skyTexture, tvTexture, wallTexture, windowTexture } from "../../public/js/textures.js";
import { TIMES_OF_DAY, clockTheme, hueColors, themeLook } from "../../public/js/model.js";
import { buildGeometry, buildMeshGeometry } from "../../public/js/voxel.js";
import { installDocument } from "./pixel-canvas.js";
import { screenKey, screenSpec, screenStyle } from "../../public/js/screen.js";
import { DESK_SCREEN } from "../../public/js/furniture.js";
import { STATIONS, nextStation } from "../../public/js/radio.js";
import { CLOUD_BAND, CLOUD_SPEED, backdrop } from "../../public/js/backdrop.js";
import { cueGate, soundCues } from "../../public/js/sound-plan.js";

installDocument();

const TEXTURES = {
  grain: () => grainTexture(), grass: () => grassTexture(), plinth: () => plinthTexture(), rug: () => rugTexture(),
  floor: (m) => floorTexture(m), wall: (m) => wallTexture(m),
  screen: () => screenTexture(), screenOff: () => screenOffTexture(), tv: () => tvTexture(), rack: () => rackTexture(), window: () => windowTexture(false), sky: (time) => skyTexture(time === "night"),
  nightWindow: (style) => nightWindowTexture(style),
};

let state = null;
let cues = [];
const gate = cueGate();
let walk = null; // {blocked, grid} of the last scene, for route()

/** scene.js KIND_LIGHTS_MAX: custom kinds' coloured point lights the room carries at once. */
const KIND_LIGHTS_MAX = 12;

/** A BufferGeometry as JSON-ready {pos, nor, col (linear), uv, idx}; unindexed geometry gets 0…n-1. */
function meshData(g) {
  const a = g.attributes;
  const r = (arr) => arr.map((v) => Math.round(v * 1e5) / 1e5);
  const idx = g.index ?? Array.from({ length: a.position.array.length / 3 }, (_, i) => i);
  return { pos: r(a.position.array), nor: a.normal.array, col: r(a.color.array), uv: r(a.uv.array), idx };
}

const boxesOf = (list) => (list ?? []).map((b) => ({ at: b.at, size: b.size, color: b.color, faces: b.faces ?? null, unitUV: !!b.unitUV }));

/** A kind's parts as plain box lists: role base | accent | finish | rail | glow | glass. */
function kindParts(kind, custom) {
  if (MODELS[kind]) {
    const m = MODELS[kind]();
    return {
      defaultColor: m.defaultColor ?? null,
      glowColor: m.glow?.color ?? null,
      glowLamp: !!m.glow?.lamp,
      parts: [
        { role: "base", boxes: boxesOf(m.base) },
        { role: "accent", boxes: boxesOf(m.accent), map: m.accentMap === "rug" ? "rug" : "grain" },
        { role: "finish", boxes: boxesOf(m.finish) },
        { role: "rail", boxes: boxesOf(m.rail) },
        { role: "glow", boxes: boxesOf(m.glow?.boxes), map: m.glow?.tex ?? null },
      ].filter((p) => p.boxes.length),
    };
  }
  const def = custom[kind];
  if (!def) throw new Error(`no model for kind "${kind}"`);
  const plan = kindGeometryPlan(def);
  const toBox = (b, unitUV = false) => ({ at: [b.cx, b.y0, b.cz], size: [b.w, b.h, b.d], color: b.color, faces: null, unitUV, ...(b.slope ? { slope: b.slope, lowFrac: b.lowFrac } : {}) });
  const meshPart = (bucket, role) => {
    const meshes = plan.meshes.filter((m) => m.bucket === bucket);
    return { role, boxes: [], map: null, mesh: meshes.length ? meshData(buildMeshGeometry(meshes)) : null };
  };
  return {
    defaultColor: null,
    glowColor: null,
    glowLamp: false,
    parts: [
      { role: "base", boxes: [...plan.matte, ...plan.glossy].map((b) => toBox(b)) },
      { role: "flat", boxes: plan.flat.map((b) => toBox(b)) },
      { role: "glass", boxes: plan.glass.map((b) => toBox(b)) },
      { role: "glow", boxes: plan.screen.map((b) => toBox(b, true)), map: "screen" },
      { role: "glow", boxes: plan.emissive.map((b) => toBox(b)), map: null },
      meshPart("flat", "meshFlat"),
      meshPart("glossy", "meshGlossy"),
      meshPart("emissive", "meshGlow"),
    ].filter((p) => p.boxes.length || p.mesh),
  };
}

/** Where every agent should be right now: desk while working, its chosen place, else its wander slot's spot. */
function targets(now) {
  const custom = state.customKinds ?? {};
  const seating = deskSeating(state.agents, state.items);
  const blocked = blockedCells(state.items, state.grid, custom);
  const spots = usableSpots(idleSpots(state.items, custom), blocked, state.grid);
  const entry = entryPoint(blocked, state.grid);
  const chosen = new Map();
  for (const a of state.agents) {
    if (a.at === "desk" && seating.has(a.id)) chosen.set(a.id, "desk");
    else if (a.at) {
      const s = spots.find((x) => x.id === a.at);
      if (s) chosen.set(a.id, s);
    }
  }
  const free = spots.filter((s) => ![...chosen.values()].includes(s));
  const wanters = state.agents
    .filter((a) => !chosen.has(a.id) && poseFor(a, seating.has(a.id), now).place === "lounge")
    .map((a) => ({ id: a.id, joinedAt: a.joinedAt, salt: wanderSalt(a.id, now), current: null, restless: false }));
  const assign = assignSpots(wanters, free);
  const out = new Map();
  for (const a of state.agents) {
    const desk = seating.get(a.id);
    const pick = chosen.get(a.id);
    const { pose, place } = poseFor(a, !!desk, now);
    if (pick === "desk" || (place === "desk" && desk && !pick)) {
      const s = seatOf(desk);
      out.set(a.id, { key: `desk:${desk.id}`, x: s.x, z: s.z, yaw: s.yaw, pose: pick === "desk" && a.status === "idle" ? "sit" : pose, seatY: SEAT_Y });
      continue;
    }
    const spot = pick && pick !== "desk" ? pick : (assign.get(a.id) ?? null);
    if (spot) {
      out.set(a.id, { key: `spot:${spot.id}`, x: spot.x, z: spot.z, yaw: spot.yaw, pose: pose === "wave" ? "wave" : spot.pose, seatY: spot.seatY ?? SEAT_Y });
      continue;
    }
    const h = hashStr(a.id + wanderSalt(a.id, now));
    out.set(a.id, { key: `mill:${h % 97}`, x: entry.x + ((h % 5) - 2) * 0.9, z: Math.max(0.5, entry.z - 1 - ((h >> 3) % 3) * 0.9), yaw: Math.PI, pose: "stand", seatY: SEAT_Y });
  }
  return out;
}

/** Each sitter's monitor: where it hangs (over its desk's own screen glass) and what it shows (key changes = repaint). */
function deskScreens() {
  const custom = state.customKinds ?? {};
  const seating = deskSeating(state.agents, state.items);
  return state.agents.filter((a) => seating.has(a.id)).map((a) => {
    const desk = seating.get(a.id), css = hueColors(a.hue ?? 0).css;
    const p = itemPoint(desk, DESK_SCREEN.x, DESK_SCREEN.z + 0.008, custom), q = itemPoint(desk, DESK_SCREEN.x, DESK_SCREEN.z + 0.45, custom);
    return {
      agent: a.id, key: screenKey(a, css), x: p.x, y: DESK_SCREEN.y + DESK_SCREEN.h / 2, z: p.z, yaw: p.yaw, w: DESK_SCREEN.w, h: DESK_SCREEN.h,
      // the light it spills on the desk top at night
      spill: { x: q.x, z: q.z, color: screenStyle(a.client, css).accent, lit: a.status === "working" || a.status === "waiting" },
    };
  });
}

function timeOfDay(name) {
  if (!TIMES_OF_DAY[name]) throw new Error(`unknown time of day ${JSON.stringify(name)}`);
  return { name, ...TIMES_OF_DAY[name] };
}

/** A chat ref as people read it: an agent's display name, a human's name, or the office. */
function nameOf(ref) {
  if (ref.startsWith("human:")) return ref.slice(6);
  return state.agents.find((a) => a.id === ref)?.name ?? ref;
}


globalThis.AO = {
  /** The web viewer's A* walk from one point to another (cell centres, then the exact goal), as JSON [[x, z], …]. */
  route(fx, fz, tx, tz) {
    if (!walk) return "[]";
    return JSON.stringify(route(walk.blocked, walk.grid, { x: fx, z: fz }, { x: tx, z: tz }).map((p) => [p.x, p.z]));
  },
  /** The web overlay's label culling: JSON [{id, x, y, w, h, depth, status, selected, speaking, kept}] → JSON [kept ids]. */
  cull(json) {
    const rects = JSON.parse(json).map((r) => ({ ...r, priority: labelPriority(r) + (r.kept ? 5 : 0) }));
    return JSON.stringify([...cullLabels(rects)]);
  },
  /** limbAngles() for many characters at once: JSON [{pose, phase}] at clock t → JSON [angles]. */
  limbs(json, t) {
    return JSON.stringify(JSON.parse(json).map((c) => limbAngles(c.pose, t, c.phase)));
  },
  /** voxel.js's merged mesh for a box list (JSON) as JSON {pos, nor, col (linear), uv, idx}: baked AO, world UVs. */
  mesh(json, ao, floorY) {
    return JSON.stringify(meshData(buildGeometry(JSON.parse(json).map((b) => ({ ...b, faces: b.faces ?? undefined })), { ao, floorY })));
  },
  /** One of textures.js's voxel textures as JSON {w, h, rgb: hex string, 6 chars per pixel}. */
  texture(name, arg) {
    const make = TEXTURES[name];
    if (!make) throw new Error(`no texture "${name}"`);
    const c = make(arg).image;
    let rgb = "";
    for (const v of c.pixels) rgb += v.toString(16).padStart(2, "0");
    return JSON.stringify({ w: c.width, h: c.height, rgb });
  },
  /** The room shell for a grid: garden slab size, garden boxes, the four walls (full + stub boxes, frame) and posts. */
  room(w, d) {
    const grid = { w, d };
    return JSON.stringify({
      border: GARDEN_BORDER,
      garden: gardenBoxes(grid),
      walls: roomWalls(grid).map((wall) => ({ ...wall, ...wallBoxes(wall.len, wall.doorAt) })),
      posts: cornerPosts(grid),
      backdrop: { ...backdrop(grid), cloudSpeed: CLOUD_SPEED, cloudBand: CLOUD_BAND },
    });
  },
  /** One WebSocket frame (JSON text); returns its type. */
  frame(text) {
    const f = JSON.parse(text);
    if (f.type === "pong" || f.type === "error") return f.type;
    const before = state;
    state = applyFrame(state, f);
    cues.push(...soundCues(before, f, state));
    return f.type;
  },
  /** radio.js: the station after `id` ("" = off) as JSON {id, name, url} or null. */
  nextStation(id) {
    const next = nextStation(id || null);
    return JSON.stringify(STATIONS.find((s) => s.id === next) ?? null);
  },
  /** screen.js's paint ops for one agent's desk monitor, as JSON {w, h, ops}. */
  screen(agentId) {
    const a = state.agents.find((x) => x.id === agentId);
    if (!a) throw new Error(`no agent ${agentId}`);
    return JSON.stringify(screenSpec(a, hueColors(a.hue ?? 0).css));
  },
  /** The sound cues frames produced since the last call that pass sound-plan.js's rate limits, as JSON. */
  cues(now) {
    const out = cues.filter((c) => gate(c, now));
    cues = [];
    return JSON.stringify(out);
  },
  /** Everything the renderer needs, as JSON. `time` forces "day" or "night"; empty follows the local clock like the web. */
  scene(now, time) {
    if (!state) return JSON.stringify(null);
    const custom = state.customKinds ?? {};
    const { batches } = layoutBatches(state.items, custom);
    const items = [...batches.values()].flat();
    const kinds = {};
    for (const it of items) if (!kinds[it.kind]) kinds[it.kind] = kindParts(it.kind, custom);
    const t = targets(now);
    walk = { blocked: blockedCells(state.items, state.grid, custom), grid: state.grid };
    return JSON.stringify({
      id: state.id,
      name: state.name ?? null,
      grid: state.grid,
      wallH: WALL_H,
      theme: state.theme,
      look: themeLook(state.theme),
      time: timeOfDay(time || clockTheme(new Date(now))),
      kinds,
      items,
      lights: placedLights(state.items, custom).slice(0, KIND_LIGHTS_MAX),
      agents: state.agents.map((a) => ({
        id: a.id, name: a.name, emoji: a.emoji ?? null, status: a.status, activity: a.activity ?? null, hue: a.hue,
        css: hueColors(a.hue ?? 0).css, phase: (hashStr(a.id) % 1000) / 100, says: a.says && now - a.says.ts < 9000 ? a.says.text : null,
        rig: characterRig(a), target: t.get(a.id),
      })),
      screens: deskScreens(),
      chat: state.chat.slice(-40).map((m) => ({ from: nameOf(m.from), to: m.to ? nameOf(m.to) : null, text: m.text, ts: m.ts })),
    });
  },
};
