// The room shell as plain box lists: the garden around the office and the four walls with their cutaway
// stubs. Pure, so the browser and the Apple TV viewer build the same room from the same numbers.

import { WALL_H } from "./furniture.js";
import { hashStr } from "./model.js";
import { vbox } from "./voxel.js";

/** How far the garden slab reaches past the walls, in cells. */
export const GARDEN_BORDER = 2.5;

/** Trees, bushes, flowers and a stone path to the door, seeded by the grid so every viewer plants the same garden. */
export function gardenBoxes(grid) {
  const W = grid.w, D = grid.d;
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
  for (let z = D + 0.3; z < D + GARDEN_BORDER; z += 0.7) deco.push(vbox(W / 2 + (rnd() - 0.5) * 0.2, -0.04, z, 0.9, 0.06, 0.5, "#c9c2b4"));
  return deco;
}

/**
 * One wall in its own frame (along +x from 0 to len, inner face +z): the full wall's body and trim boxes, and the
 * low stub shown instead when the camera is behind it. A door leaves a 2-cell gap with a lintel above.
 */
export function wallBoxes(len, doorAt) {
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
}

/**
 * The four walls: which surface paints each (back/left can carry the theme's accent), its length, door, and where its
 * frame sits (position + y rotation). The front wall has the door in the middle.
 */
export function roomWalls(grid) {
  const W = grid.w, D = grid.d;
  return [
    { name: "back", surface: "wallBack", len: W, doorAt: null, at: [0, 0, 0], yaw: 0 },
    { name: "front", surface: "wallPlain", len: W, doorAt: W / 2, at: [W, 0, D], yaw: Math.PI },
    { name: "left", surface: "wallLeft", len: D, doorAt: null, at: [0, 0, D], yaw: Math.PI / 2 },
    { name: "right", surface: "wallPlain", len: D, doorAt: null, at: [W, 0, 0], yaw: -Math.PI / 2 },
  ];
}

/** Corner posts, in room coordinates. */
export function cornerPosts(grid) {
  const W = grid.w, D = grid.d;
  return [[0, 0], [W, 0], [0, D], [W, D]].map(([x, z]) => vbox(x, 0, z, 0.3, WALL_H + 0.12, 0.3, "#ffffff"));
}

/** Which walls the camera is behind (those swap to their stub so the room stays visible). */
export function cutaway(grid, cam) {
  return { back: cam.z < 0.5, front: cam.z > grid.d - 0.5, left: cam.x < 0.5, right: cam.x > grid.w - 0.5 };
}
