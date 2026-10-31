// Block-built furniture for every catalog kind, as box lists in the item's local frame: origin at the
// footprint centre, 1 unit = 1 cell, front faces +z (rot 0). Each kind splits into
//   base   — fixed vertex colours,
//   accent — light vertex colours tinted per instance (item.color or the kind's default),
//   glow   — emissive parts (screens, lamp shades, LEDs) that light up at night,
// plus where a textable item's text panel sits.

import { vbox, FRONT } from "./voxel.js";
import { KINDS } from "../shared/catalog.js";

export const SEAT_Y = 0.46;
export const WALL_H = 2.6;

const WOOD = "#d6a46a", WOOD_D = "#8c5d3c", DESK = "#f3ede2", DARK = "#2e313a", METAL = "#5b6070", WHITE = "#ffffff";
const LEAF = ["#5fae4e", "#4f9c43", "#72c05a", "#3f8a3a"];
const POT = "#c9744f";

const front = { faces: [FRONT], unitUV: true };

function chairBoxes(z, backAtPlusZ, accent) {
  const bz = backAtPlusZ ? z + 0.27 : z - 0.27;
  return {
    base: [
      vbox(0, 0.04, z, 0.08, 0.32, 0.08, DARK),
      vbox(0, 0.02, z, 0.5, 0.05, 0.08, DARK),
      vbox(0, 0.02, z, 0.08, 0.05, 0.5, DARK),
    ],
    accent: [
      vbox(0, 0.36, z, 0.56, 0.1, 0.54, accent),
      vbox(0, 0.46, bz, 0.54, 0.52, 0.08, accent),
      vbox(0, 0.58, bz + (backAtPlusZ ? -0.03 : 0.03), 0.4, 0.3, 0.04, "#e6e6e6"),
    ],
  };
}

function leaves(cx, y, cz, s = 1) {
  return [
    vbox(cx, y, cz, 0.5 * s, 0.38 * s, 0.5 * s, LEAF[0]),
    vbox(cx + 0.12 * s, y + 0.3 * s, cz + 0.06 * s, 0.34 * s, 0.3 * s, 0.34 * s, LEAF[2]),
    vbox(cx - 0.14 * s, y + 0.22 * s, cz - 0.1 * s, 0.3 * s, 0.3 * s, 0.3 * s, LEAF[1]),
    vbox(cx + 0.02 * s, y + 0.55 * s, cz - 0.04 * s, 0.22 * s, 0.22 * s, 0.22 * s, LEAF[3]),
  ];
}

function books(y, seed) {
  const cols = ["#e0614f", "#f0b44c", "#5b8fd9", "#7cc47a", "#b77ad6", "#f2efe6", "#2f6f73", "#e88aa6"];
  const out = [];
  let x = -0.82, i = seed;
  while (x < 0.8) {
    i = (i * 1103515245 + 12345) & 0x7fffffff;
    const w = 0.07 + (i % 5) * 0.018;
    const h = 0.24 + ((i >> 4) % 5) * 0.025;
    if (x + w > 0.84) break;
    if ((i >> 9) % 7 !== 0) out.push(vbox(x + w / 2, y, -0.12, w - 0.008, h, 0.4, cols[(i >> 6) % cols.length]));
    x += w;
  }
  return out;
}

/** kind → { base, accent, glow: {boxes, tex, color}, defaultColor, text?: {x, y, z, w, h, bg, fg, border} } */
export const MODELS = {
  desk: () => {
    const ch = chairBoxes(0.5, true, WHITE);
    return {
      defaultColor: "#6aa6c9",
      base: [
        vbox(0, 0.68, -0.5, 1.86, 0.07, 0.88, WOOD),
        vbox(-0.86, 0, -0.5, 0.08, 0.68, 0.8, DESK),
        vbox(0.86, 0, -0.5, 0.08, 0.68, 0.8, DESK),
        vbox(0, 0.24, -0.88, 1.64, 0.4, 0.04, DESK),
        vbox(0, 0.75, -0.74, 0.3, 0.025, 0.18, DARK),
        vbox(0, 0.775, -0.75, 0.08, 0.16, 0.05, DARK),
        vbox(0, 0.88, -0.76, 0.88, 0.54, 0.06, DARK),
        vbox(0, 0.75, -0.3, 0.52, 0.03, 0.17, "#ebe7df"),
        vbox(0.4, 0.75, -0.3, 0.07, 0.03, 0.1, "#ebe7df"),
        vbox(-0.68, 0.75, -0.74, 0.16, 0.13, 0.16, POT),
        vbox(-0.68, 0.88, -0.74, 0.22, 0.14, 0.22, LEAF[2]),
        vbox(-0.66, 1.0, -0.72, 0.12, 0.1, 0.12, LEAF[0]),
        vbox(0.62, 0.75, -0.55, 0.1, 0.12, 0.1, "#fdfaf3"),
        vbox(0.68, 0.79, -0.55, 0.04, 0.06, 0.03, "#fdfaf3"),
        ...ch.base,
      ],
      accent: ch.accent,
      glow: { boxes: [vbox(0, 0.91, -0.725, 0.8, 0.46, 0.01, WHITE, front)], tex: "screen" },
    };
  },
  chair: () => {
    const ch = chairBoxes(0, false, WHITE);
    return { defaultColor: "#e39a5b", base: ch.base, accent: ch.accent };
  },
  plant: () => ({
    defaultColor: POT,
    base: [vbox(0, 0.32, 0, 0.36, 0.04, 0.36, "#5b3d2a"), ...leaves(0, 0.36, 0)],
    accent: [vbox(0, 0, 0, 0.4, 0.34, 0.4, WHITE), vbox(0, 0.3, 0, 0.48, 0.08, 0.48, "#eeeeee")],
  }),
  sofa: () => ({
    defaultColor: "#6f9fc0",
    base: [-1.3, 1.3].flatMap((x) => [vbox(x, 0, 0.3, 0.1, 0.1, 0.1, WOOD_D), vbox(x, 0, -0.3, 0.1, 0.1, 0.1, WOOD_D)]),
    accent: [
      vbox(0, 0.1, 0.02, 2.9, 0.26, 0.84, "#d9d9d9"),
      ...[-0.94, 0, 0.94].map((x) => vbox(x, 0.36, 0.1, 0.9, 0.12, 0.66, WHITE)),
      vbox(0, 0.36, -0.32, 2.5, 0.52, 0.2, "#efefef"),
      ...[-0.94, 0, 0.94].map((x) => vbox(x, 0.5, -0.2, 0.86, 0.34, 0.08, WHITE)),
      vbox(-1.36, 0.36, 0.02, 0.18, 0.24, 0.84, "#e2e2e2"),
      vbox(1.36, 0.36, 0.02, 0.18, 0.24, 0.84, "#e2e2e2"),
    ],
  }),
  lamp: () => ({
    defaultColor: DARK,
    base: [],
    accent: [vbox(0, 0, 0, 0.32, 0.05, 0.32, "#cccccc"), vbox(0, 0.05, 0, 0.06, 1.22, 0.06, "#cccccc")],
    glow: { boxes: [vbox(0, 1.2, 0, 0.42, 0.34, 0.42, WHITE), vbox(0, 1.54, 0, 0.3, 0.04, 0.3, WHITE)], tex: null, color: "#ffe1ad", lamp: true },
  }),
  bookshelf: () => ({
    defaultColor: WOOD_D,
    base: [0.06, 0.48, 0.9, 1.32].flatMap((y, i) => books(y, 7 + i * 13)),
    accent: [
      vbox(0, 0, -0.4, 1.9, 1.72, 0.06, "#d8d8d8"),
      vbox(-0.92, 0, -0.12, 0.08, 1.72, 0.58, WHITE),
      vbox(0.92, 0, -0.12, 0.08, 1.72, 0.58, WHITE),
      ...[0, 0.42, 0.84, 1.26, 1.66].map((y) => vbox(0, y, -0.12, 1.84, 0.06, 0.58, WHITE)),
    ],
  }),
  rug: () => ({
    defaultColor: "#d98f6f",
    base: [],
    accent: [vbox(0, 0, 0, 3.8, 0.025, 5.8, WHITE, { faces: [2], unitUV: true }), vbox(0, 0, 0, 3.8, 0.025, 5.8, "#bbbbbb", { faces: [0, 1, 4, 5] })],
    accentMap: "rug",
    noShadow: true,
  }),
  whiteboard: () => ({
    defaultColor: "#c9ced6",
    base: [vbox(0, 0.9, -0.38, 0.9, 0.04, 0.1, "#b6bcc6"), vbox(-0.2, 0.94, -0.36, 0.14, 0.03, 0.03, "#e0614f"), vbox(0.05, 0.94, -0.36, 0.14, 0.03, 0.03, "#3f72c8")],
    accent: [vbox(0, 0.92, -0.46, 1.84, 1.0, 0.07, WHITE)],
    text: { x: 0, y: 1.42, z: -0.42 + 0.004, w: 1.72, h: 0.9, bg: "#fbfcfe", fg: "#2b4a86", tw: 256, th: 134 },
  }),
  sign: () => ({
    defaultColor: "#3a4a3f",
    base: [vbox(0, 0, 0, 0.08, 0.72, 0.08, WOOD_D), vbox(0, 0, 0, 0.36, 0.05, 0.3, WOOD_D)],
    accent: [vbox(0, 0.68, 0, 0.96, 0.6, 0.08, WHITE), vbox(0, 0.66, 0, 1.0, 0.04, 0.1, "#dddddd"), vbox(0, 1.28, 0, 1.0, 0.04, 0.1, "#dddddd")],
    text: { x: 0, y: 0.98, z: 0.044, w: 0.86, h: 0.5, bg: "#34433a", fg: "#f6f1e3", tw: 172, th: 100 },
  }),
  fridge: () => ({
    defaultColor: "#b9e2d3",
    base: [
      vbox(0.28, 1.2, 0.33, 0.05, 0.34, 0.06, "#8d979f"),
      vbox(0.28, 0.5, 0.33, 0.05, 0.3, 0.06, "#8d979f"),
      vbox(-0.15, 1.45, 0.305, 0.07, 0.07, 0.02, "#e0614f"),
      vbox(-0.02, 1.35, 0.305, 0.06, 0.08, 0.02, "#f0b44c"),
      vbox(-0.22, 1.25, 0.305, 0.12, 0.1, 0.02, "#fdfaf3"),
    ],
    accent: [vbox(0, 0, -0.05, 0.78, 1.72, 0.7, WHITE), vbox(0, 1.06, 0.3, 0.8, 0.02, 0.02, "#bcbcbc")],
  }),
  "coffee-machine": () => ({
    defaultColor: "#d9534f",
    base: [
      vbox(0, 0, 0, 0.92, 0.86, 0.8, WOOD),
      vbox(0, 0.4, 0.401, 0.02, 0.4, 0.01, WOOD_D),
      vbox(0, 0.86, 0, 0.96, 0.05, 0.84, "#ece6dc"),
      vbox(0, 1.13, 0.1, 0.12, 0.06, 0.12, DARK),
      vbox(0, 0.91, 0.12, 0.1, 0.1, 0.1, "#fdfaf3"),
      vbox(-0.32, 0.91, 0.1, 0.1, 0.1, 0.1, "#5b8fd9"),
      vbox(-0.32, 0.91, -0.08, 0.1, 0.1, 0.1, "#f0b44c"),
    ],
    accent: [vbox(0.05, 0.91, -0.12, 0.44, 0.48, 0.36, WHITE), vbox(0.05, 1.39, -0.12, 0.36, 0.04, 0.3, "#dddddd")],
    glow: { boxes: [vbox(0.18, 1.26, 0.061, 0.06, 0.06, 0.01, WHITE)], tex: null, color: "#8dffb5" },
  }),
  table: () => ({
    defaultColor: WOOD,
    base: [
      ...[[-0.78, -0.78], [0.78, -0.78], [-0.78, 0.78], [0.78, 0.78]].map(([x, z]) => vbox(x, 0, z, 0.1, 0.66, 0.1, WOOD_D)),
      vbox(0.2, 0.74, -0.1, 0.16, 0.18, 0.16, "#f2efe6"),
      vbox(0.2, 0.92, -0.1, 0.22, 0.12, 0.22, "#f28aa6"),
      vbox(-0.35, 0.74, 0.3, 0.12, 0.1, 0.12, "#fdfaf3"),
    ],
    accent: [vbox(0, 0.66, 0, 1.84, 0.08, 1.84, WHITE)],
  }),
  tv: () => ({
    defaultColor: WOOD_D,
    base: [vbox(0, 0.44, -0.08, 0.14, 0.12, 0.06, DARK), vbox(0, 0.56, -0.09, 1.72, 0.98, 0.08, DARK)],
    accent: [vbox(0, 0, 0, 1.86, 0.44, 0.6, WHITE), vbox(-0.45, 0.06, 0.301, 0.7, 0.3, 0.01, "#e4e4e4"), vbox(0.45, 0.06, 0.301, 0.7, 0.3, 0.01, "#e4e4e4")],
    glow: { boxes: [vbox(0, 0.6, -0.04, 1.6, 0.9, 0.01, WHITE, front)], tex: "tv" },
  }),
  window: () => ({
    defaultColor: WHITE,
    base: [],
    accent: [
      vbox(0, 0.86, -0.47, 1.76, 0.08, 0.1, WHITE),
      vbox(0, 2.06, -0.47, 1.76, 0.08, 0.1, WHITE),
      vbox(-0.84, 0.86, -0.47, 0.08, 1.28, 0.1, WHITE),
      vbox(0.84, 0.86, -0.47, 0.08, 1.28, 0.1, WHITE),
      vbox(0, 0.94, -0.44, 0.05, 1.12, 0.06, WHITE),
      vbox(0, 1.48, -0.44, 1.6, 0.04, 0.06, WHITE),
      vbox(0, 0.82, -0.38, 1.9, 0.06, 0.22, "#eeeeee"),
    ],
    glow: { boxes: [vbox(0, 0.94, -0.465, 1.6, 1.12, 0.01, WHITE, front)], tex: "window" },
    noShadow: true,
  }),
  poster: () => ({
    defaultColor: "#f2c879",
    base: [],
    accent: [vbox(0, 1.02, -0.475, 0.74, 0.96, 0.05, WHITE)],
    text: { x: 0, y: 1.5, z: -0.45 + 0.004, w: 0.62, h: 0.84, bg: "#fff7e6", fg: "#5a3b2a", tw: 100, th: 136, border: null },
  }),
  "server-rack": () => ({
    defaultColor: "#2a2e38",
    base: [vbox(0, 1.9, 0, 0.6, 0.03, 0.6, "#3b404d"), vbox(0, 0, 0, 0.84, 0.06, 0.84, "#1d2027")],
    accent: [vbox(0, 0.06, 0, 0.8, 1.84, 0.8, WHITE)],
    glow: { boxes: [vbox(0, 0.16, 0.401, 0.64, 1.66, 0.01, WHITE, front)], tex: "rack" },
  }),
  beanbag: () => ({
    defaultColor: "#f2a65a",
    base: [],
    accent: [
      vbox(0, 0, 0, 0.86, 0.26, 0.86, "#e6e6e6"),
      vbox(0, 0.26, 0.04, 0.74, 0.14, 0.7, WHITE),
      vbox(0, 0.26, -0.28, 0.76, 0.42, 0.26, "#f2f2f2"),
      vbox(0, 0.68, -0.3, 0.5, 0.08, 0.18, WHITE),
    ],
  }),
};

for (const k of Object.keys(KINDS)) if (!MODELS[k]) throw new Error(`furniture: no model for catalog kind "${k}"`);
for (const k of Object.keys(MODELS)) if (!KINDS[k]) throw new Error(`furniture: model "${k}" is not in the catalog`);
