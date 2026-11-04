// The Apple TV viewer's brain, run in JavaScriptCore: the web viewer's own pure modules decide furniture shapes,
// desk seating, idle spots and wandering, so the TV places everything exactly where a browser would. Swift feeds
// it the office WebSocket frames and draws what scene() returns.
import { MODELS, SEAT_Y, WALL_H } from "../../public/js/furniture.js";
import {
  applyFrame, assignSpots, deskSeating, entryPoint, hashStr, idleSpots, kindGeometryPlan, layoutBatches, poseFor, seatOf,
  usableSpots, wanderSalt, hueColors,
} from "../../public/js/model.js";
import { blockedCells } from "../../public/shared/kinds.js";
import { kindOf } from "../../public/shared/catalog.js";
import { lookFor } from "../../public/js/character.js";

let state = null;

const boxesOf = (list) => (list ?? []).map((b) => ({ at: b.at, size: b.size, color: b.color }));

/** A kind's parts as plain box lists: role base | accent | finish | rail | glow | glass. */
function kindParts(kind, custom) {
  if (MODELS[kind]) {
    const m = MODELS[kind]();
    return {
      defaultColor: m.defaultColor ?? null,
      glowColor: m.glow?.color ?? null,
      parts: [
        { role: "base", boxes: boxesOf(m.base) },
        { role: "accent", boxes: boxesOf(m.accent) },
        { role: "finish", boxes: boxesOf(m.finish) },
        { role: "rail", boxes: boxesOf(m.rail) },
        { role: "glow", boxes: boxesOf(m.glow?.boxes) },
      ].filter((p) => p.boxes.length),
    };
  }
  const def = custom[kind];
  if (!def) throw new Error(`no model for kind "${kind}"`);
  const plan = kindGeometryPlan(def);
  const toBox = (b) => ({ at: [b.cx, b.y0, b.cz], size: [b.w, b.h, b.d], color: b.color });
  return {
    defaultColor: null,
    glowColor: null,
    parts: [
      { role: "base", boxes: [...plan.matte, ...plan.glossy].map(toBox) },
      { role: "glass", boxes: plan.glass.map(toBox) },
      { role: "glow", boxes: [...plan.screen, ...plan.emissive].map(toBox) },
    ].filter((p) => p.boxes.length),
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
    .filter((a) => !chosen.has(a.id) && poseFor(a, seating.has(a.id)).place === "lounge")
    .map((a) => ({ id: a.id, joinedAt: a.joinedAt, salt: wanderSalt(a.id, now), current: null, restless: false }));
  const assign = assignSpots(wanters, free);
  const out = new Map();
  for (const a of state.agents) {
    const desk = seating.get(a.id);
    const pick = chosen.get(a.id);
    const { pose, place } = poseFor(a, !!desk);
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

/** A chat ref as people read it: an agent's display name, a human's name, or the office. */
function nameOf(ref) {
  if (ref.startsWith("human:")) return ref.slice(6);
  return state.agents.find((a) => a.id === ref)?.name ?? ref;
}

globalThis.AO = {
  /** One WebSocket frame (JSON text); returns its type. */
  frame(text) {
    const f = JSON.parse(text);
    if (f.type === "pong" || f.type === "error") return f.type;
    state = applyFrame(state, f);
    return f.type;
  },
  /** Everything the renderer needs, as JSON. */
  scene(now) {
    if (!state) return JSON.stringify(null);
    const custom = state.customKinds ?? {};
    const { batches } = layoutBatches(state.items, custom);
    const items = [...batches.values()].flat();
    const kinds = {};
    for (const it of items) if (!kinds[it.kind]) kinds[it.kind] = kindParts(it.kind, custom);
    const t = targets(now);
    return JSON.stringify({
      id: state.id,
      name: state.name ?? null,
      grid: state.grid,
      wallH: WALL_H,
      theme: state.theme,
      kinds,
      items,
      agents: state.agents.map((a) => ({
        id: a.id, name: a.name, status: a.status, activity: a.activity ?? null, hue: a.hue,
        look: lookFor(a), target: t.get(a.id),
      })),
      chat: state.chat.slice(-6).map((m) => ({ from: nameOf(m.from), to: m.to ? nameOf(m.to) : null, text: m.text, ts: m.ts })),
    });
  },
};
