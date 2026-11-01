// Street-level models as plain box lists (blocks; 1 block = 3 m), shared by the mesher (static furniture and
// parked cars, merged into the LOD0 chunk props mesh) and traffic.js (instanced moving cars and cable cars).
// Local frame: x right, y up from the ground, z forward (the street.bin `rot` heading). A box is
// {x, y, z (centre of the footprint, bottom y), w, h, d, color: "#rrggbb", glow?: true}. Plain ESM, no deps.

/** Sidewalk height over the carriageway (blocks): road tops are drawn this far below the column's ground. */
export const CURB = 0.1;
/** Lane paint and rails (the decals mesh) are drawn only while the camera is this close to its target. */
export const DECAL_DIST = 420;

export const PAINT = Object.freeze({ white: "#e8e6de", yellow: "#e2b13a", rail: "#9aa0a8", slot: "#2a2c30", sleeper: "#5a4b3e", curb: "#c4bfb5" });

const box = (x, y, z, w, h, d, color, glow = false) => Object.freeze({ x, y, z, w, h, d, color, ...(glow ? { glow: true } : {}) });

const STEEL = "#4a4f57";
const POLE = "#5d636b";
const LIGHT = "#fff1c9";

export const LAMP_BOXES = Object.freeze([
  box(0, 0, 0, 0.08, 2.75, 0.08, POLE),
  box(0, 0.02, 0, 0.14, 0.12, 0.14, POLE),
  box(0, 2.66, 0.28, 0.05, 0.05, 0.56, POLE),
  box(0, 2.58, 0.56, 0.16, 0.1, 0.24, STEEL),
  box(0, 2.55, 0.56, 0.12, 0.03, 0.2, LIGHT, true),
]);

export const HYDRANT_BOXES = Object.freeze([
  box(0, 0, 0, 0.12, 0.2, 0.12, "#e9e4d6"),
  box(0, 0.2, 0, 0.15, 0.05, 0.15, "#3b6fb6"),
  box(0, 0.1, 0, 0.2, 0.05, 0.05, "#e9e4d6"),
]);

export const BENCH_BOXES = Object.freeze([
  box(-0.24, 0, 0, 0.04, 0.15, 0.14, STEEL),
  box(0.24, 0, 0, 0.04, 0.15, 0.14, STEEL),
  box(0, 0.15, 0, 0.6, 0.035, 0.17, "#8a6440"),
  box(0, 0.19, -0.075, 0.6, 0.14, 0.03, "#8a6440"),
]);

export const SHELTER_BOXES = Object.freeze([
  box(-0.6, 0, -0.18, 0.04, 0.85, 0.04, "#8d939b"),
  box(0.6, 0, -0.18, 0.04, 0.85, 0.04, "#8d939b"),
  box(-0.6, 0, 0.18, 0.04, 0.85, 0.04, "#8d939b"),
  box(0.6, 0, 0.18, 0.04, 0.85, 0.04, "#8d939b"),
  box(0, 0.85, 0, 1.32, 0.05, 0.5, "#9aa2ac"),
  box(0, 0.08, -0.2, 1.2, 0.72, 0.02, "#a9c4d2"),
  box(-0.62, 0.08, 0, 0.02, 0.72, 0.36, "#d24b3a", true),
  box(0, 0.14, -0.13, 0.9, 0.04, 0.12, STEEL),
]);

export const STOP_BOXES = Object.freeze([
  box(0, 0, 0, 0.04, 1.0, 0.04, POLE),
  box(0, 0.45, 0, 0.05, 0.12, 0.05, "#f2c230"),
  box(0, 0.82, 0.02, 0.2, 0.16, 0.02, "#c8352a"),
]);

export const SIGNAL_BOXES = Object.freeze([
  box(0, 0, 0, 0.07, 1.2, 0.07, "#3b3f45"),
  box(0, 0.88, 0.06, 0.12, 0.32, 0.1, "#2b2d31"),
  box(0, 1.1, 0.115, 0.06, 0.06, 0.01, "#e0453a", true),
  box(0, 0.94, 0.115, 0.06, 0.06, 0.01, "#43c46a", true),
]);

export const BIN_BOXES = Object.freeze([
  box(0, 0, 0, 0.15, 0.27, 0.15, "#2f5641"),
  box(0, 0.27, 0, 0.17, 0.03, 0.17, "#24302a"),
]);

/** Parked and moving cars: 1.45 × 0.6 blocks (4.4 × 1.8 m); `color` "body" is replaced by the car's colour. */
export const BODY = "body";
export const CAR_BOXES = Object.freeze([
  box(0, 0.07, 0, 0.6, 0.27, 1.45, BODY),
  box(0, 0.34, -0.06, 0.54, 0.22, 0.78, "#30363d"),
  box(0, 0.56, -0.06, 0.5, 0.02, 0.7, BODY),
  box(-0.27, 0, 0.45, 0.08, 0.15, 0.2, "#1d1f22"),
  box(0.27, 0, 0.45, 0.08, 0.15, 0.2, "#1d1f22"),
  box(-0.27, 0, -0.45, 0.08, 0.15, 0.2, "#1d1f22"),
  box(0.27, 0, -0.45, 0.08, 0.15, 0.2, "#1d1f22"),
]);
/** Muted car colours; a car's colour is CAR_COLORS[carColorIndex(x4, z4)]. */
export const CAR_COLORS = Object.freeze(["#e8e6e1", "#b9bdc2", "#7c8288", "#2d3136", "#2f4a6b", "#7a2e2c", "#c9b99a", "#3f5a46", "#9e3b2b", "#d8d2c4"]);
export function carColorIndex(a, b) {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) % CAR_COLORS.length;
}

/** Powell / California cable car: 2.8 × 0.8 blocks (8.4 × 2.4 m), maroon and cream, open ends. */
export const CABLE_CAR_BOXES = Object.freeze([
  box(0, 0.1, 0, 0.8, 0.32, 2.8, "#7d2430"),
  box(0, 0.42, 0, 0.82, 0.04, 2.8, "#e9dcc0"),
  box(0, 0.46, 0, 0.74, 0.42, 1.6, "#e9dcc0"),
  box(0, 0.5, 0, 0.76, 0.24, 1.5, "#3c4552"),
  box(0, 0.88, 0, 0.86, 0.08, 2.9, "#7d2430"),
  box(0, 0.96, 0, 0.5, 0.06, 2.4, "#e9dcc0"),
  box(-0.35, 0.46, 1.1, 0.04, 0.42, 0.04, "#c9a54a"),
  box(0.35, 0.46, 1.1, 0.04, 0.42, 0.04, "#c9a54a"),
  box(-0.35, 0.46, -1.1, 0.04, 0.42, 0.04, "#c9a54a"),
  box(0.35, 0.46, -1.1, 0.04, 0.42, 0.04, "#c9a54a"),
  box(0, 0, 0, 0.7, 0.1, 2.4, "#2a2c30"),
]);

/** Muni streetcar / light-rail car: 7.6 × 0.88 blocks (two-car LRV is longer; one body reads at street zoom). */
export const STREETCAR_BOXES = Object.freeze([
  box(0, 0.12, 0, 0.88, 0.5, 5.0, "#d9d6cf"),
  box(0, 0.62, 0, 0.9, 0.3, 5.0, "#2d3640"),
  box(0, 0.92, 0, 0.88, 0.12, 5.0, "#c0392b"),
  box(0, 1.04, 0, 0.3, 0.12, 0.8, "#3b3f45"),
  box(0, 0, 0, 0.7, 0.12, 4.6, "#2a2c30"),
]);
