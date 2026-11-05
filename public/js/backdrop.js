// The world around the office island, as a little diorama: a bay with golden-green hills, a downtown with a pyramid
// tower behind the back wall, a suspension bridge across the water and slow clouds (San Francisco-ish). The camera
// looks down on the room, so the horizon is never in view: the scenery sits close around the island, in miniature,
// where the home view (looking at the room's back corner) shows it. Pure box lists, seeded by the grid, so the
// browser and the Apple TV build the same backdrop; clouds drift on the shared wall clock.

import { hashStr } from "./model.js";
import { vbox } from "./voxel.js";

/** Water level (the island's grass is at 0, its plinth reaches down to -1). */
export const WATER_Y = -0.85;
/** How fast the clouds drift (cells a second, along +x) and the band they wrap around in. */
export const CLOUD_SPEED = 0.25;
export const CLOUD_BAND = 140;

// hazy, paler than the island, so they read as far away
const HILLS = ["#b9c48f", "#cbc795", "#d7cb9c", "#aebd8a", "#c3cf98"];
const TOWERS = ["#d4d3d2", "#c7ccd3", "#dedad2", "#bcc3cc", "#e6e3dc", "#c4c9c6"];

export function backdrop(grid) {
  const W = grid.w, D = grid.d;
  let seed = hashStr(`backdrop:${W}x${D}`);
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const land = [];
  const mound = (x, z, w, d, h, c) => {
    const tiers = Math.max(2, Math.round(h / 1.2));
    for (let t = 0; t < tiers; t++) {
      const k = 1 - (t / tiers) * 0.85;
      land.push(vbox(x, WATER_Y + (h / tiers) * t, z, w * k, h / tiers + 0.01, d * k, HILLS[(c + t) % HILLS.length]));
    }
  };

  // hills along the left (x < 0) and round the back-left corner, low and golden
  for (let i = 0; i < 7; i++) {
    const z = -8 + (i / 6) * (D + 12);
    mound(-15 - rnd() * 6, z, 9 + rnd() * 6, 8 + rnd() * 5, 1.2 + rnd() * 1.8, i);
  }
  mound(-17, -16, 14, 11, 3, 2);
  // and a couple beyond the right wall's far end
  mound(W + 16, -8, 11, 8, 2, 3);
  mound(W + 22, 4, 9, 7, 1.5, 1);

  // downtown behind the back wall: a cluster of towers, the tallest a stepped pyramid
  const cx = W * 0.5, cz = -17;
  land.push(vbox(cx, WATER_Y - 0.1, cz, 20, 0.5, 8, "#cfc9b8"));
  for (let i = 0; i < 26; i++) {
    const ox = (rnd() - 0.5) * 17, oz = (rnd() - 0.5) * 6;
    const near = 1 - Math.min(1, Math.abs(ox) / 9);
    const h = 1 + rnd() * 1.6 + near * 2.6, w = 0.7 + rnd() * 0.9;
    const c = TOWERS[i % TOWERS.length];
    land.push(vbox(cx + ox, WATER_Y, cz + oz, w, h, w, c));
    if (rnd() < 0.35) land.push(vbox(cx + ox, WATER_Y + h, cz + oz, w * 0.55, 0.5 + rnd(), w * 0.55, c));
  }
  for (let t = 0; t < 10; t++) {
    const k = 1 - t / 11;
    land.push(vbox(cx + 2, WATER_Y + t * 0.6, cz + 1, 1.4 * k, 0.61, 1.4 * k, "#efece4"));
  }
  land.push(vbox(cx + 2, WATER_Y + 6, cz + 1, 0.12, 0.8, 0.12, "#efece4"));

  // the bridge: from the city's shore out across the water along +x, four towers with stepped cables sagging
  // between them (axis-aligned so the voxel cables stay continuous)
  const bz = cz + 1, bx0 = cx + 9, len = W + 28 - bx0;
  const deckY = WATER_Y + 1, cableTop = deckY + 2.6, step = 0.4;
  const towersAt = [0.08, 0.36, 0.64, 0.92].map((f) => f * len);
  for (let s = 0; s < len; s += step) {
    const x = bx0 + s;
    land.push(vbox(x, deckY, bz, step + 0.01, 0.2, 0.8, "#b4bac0"));
    const i = towersAt.findIndex((t) => t > s);
    if (i > 0) {
      const a = towersAt[i - 1], b = towersAt[i], f = (s - a) / (b - a);
      const y = deckY + 0.5 + (cableTop - deckY - 0.5) * 4 * (f - 0.5) * (f - 0.5);
      for (const side of [-1, 1]) land.push(vbox(x, y, bz + side * 0.35, step + 0.01, 0.1, 0.08, "#e1e4e8"));
    }
  }
  for (const t of towersAt) {
    const x = bx0 + t;
    for (const side of [-1, 1]) land.push(vbox(x, WATER_Y, bz + side * 0.35, 0.2, cableTop - WATER_Y + 0.2, 0.2, "#d8dce0"));
    land.push(vbox(x, cableTop - 0.4, bz, 0.2, 0.15, 0.9, "#d8dce0"));
  }

  // clouds: flat blocky puffs drifting over the water behind the room, never over it
  const clouds = [];
  for (let i = 0; i < 6; i++) {
    const boxes = [];
    const n = 3 + Math.floor(rnd() * 3);
    for (let j = 0; j < n; j++) boxes.push(vbox((rnd() - 0.5) * 5, (rnd() - 0.5) * 0.4, (rnd() - 0.5) * 3, 2.5 + rnd() * 3.5, 0.7 + rnd() * 0.6, 2 + rnd() * 2.5, "#ffffff"));
    clouds.push({ boxes, x: (rnd() - 0.5) * CLOUD_BAND, y: 7 + rnd() * 3, z: -12 - rnd() * 14 });
  }

  return { land, clouds, water: { x: W / 2, z: D / 2, size: 400, y: WATER_Y, color: "#6f9fbf" } };
}

/** A cloud's x at wall-clock time `ms`: drifting along +x, wrapping round a band centred on the room. */
export function cloudX(cloud, cx, ms) {
  const d = (cloud.x + (ms / 1000) * CLOUD_SPEED + CLOUD_BAND / 2) % CLOUD_BAND;
  return cx + (d < 0 ? d + CLOUD_BAND : d) - CLOUD_BAND / 2;
}
