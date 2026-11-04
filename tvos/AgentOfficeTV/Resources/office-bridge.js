"use strict";
(() => {
  // public/js/voxel.js
  var FRONT = 4;
  function vbox(cx, y0, cz, w, h, d, color, extra = {}) {
    return { at: [cx, y0, cz], size: [w, h, d], color, ...extra };
  }

  // public/shared/catalog.js
  var GRID = Object.freeze({ w: 24, d: 16 });
  var ROTS = Object.freeze([0, 90, 180, 270]);
  var LAYERS = Object.freeze(["floor", "object", "wall"]);
  var k = (w, d, label, layer, extra = {}) => Object.freeze({ w, d, label, layer, ...extra });
  var seat = (x, z, rot = 0, height = 7) => Object.freeze({ x, z, rot, height });
  var station = (x, z, rot, activity) => Object.freeze({ x, z, rot, activity });
  var list = (...xs) => Object.freeze(xs);
  var KINDS = Object.freeze({
    desk: k(2, 2, "desk", "object", { seat: true, screen: true }),
    chair: k(1, 1, "chair", "object", { seats: list(seat(8, 8)) }),
    plant: k(1, 1, "plant", "object", { stations: list(station(8, 24, 180, "water-plants")) }),
    sofa: k(3, 1, "sofa", "object", { seats: list(seat(8, 9), seat(24, 9), seat(40, 9)) }),
    lamp: k(1, 1, "floor lamp", "object"),
    bookshelf: k(2, 1, "bookshelf", "object", { stations: list(station(16, 26, 180, "read")) }),
    rug: k(4, 6, "rug", "floor"),
    whiteboard: k(2, 1, "whiteboard", "wall", { textable: true, stations: list(station(16, 28, 180, "whiteboard")) }),
    sign: k(1, 1, "sign", "object", { textable: true }),
    fridge: k(1, 1, "fridge", "object", { stations: list(station(8, 26, 180, "snack")) }),
    "coffee-machine": k(1, 1, "coffee machine", "object", { stations: list(station(8, 26, 180, "coffee")) }),
    table: k(2, 2, "table", "object", { stations: list(station(-6, 16, 90, "chat"), station(38, 16, 270, "chat")) }),
    tv: k(2, 1, "tv", "object", { screen: true, stations: list(station(16, 32, 180, "watch")) }),
    window: k(2, 1, "window", "wall", { stations: list(station(16, 26, 180, "think")) }),
    poster: k(1, 1, "poster", "wall", { textable: true }),
    "server-rack": k(1, 1, "server rack", "object"),
    beanbag: k(1, 1, "beanbag", "object", { seats: list(seat(8, 8, 0, 5)) })
  });
  var KIND_NAMES = Object.freeze(Object.keys(KINDS));
  var OfficeError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "OfficeError";
    }
  };
  var fail = (msg) => {
    throw new OfficeError(msg);
  };
  function kindOf(kind, custom) {
    if (typeof kind !== "string") return void 0;
    if (Object.hasOwn(KINDS, kind)) return KINDS[kind];
    return custom && Object.hasOwn(custom, kind) ? custom[kind] : void 0;
  }
  function unknownKind(kind, custom) {
    const extra = custom ? Object.keys(custom) : [];
    return fail(`unknown kind ${JSON.stringify(kind)} (kinds: ${[...KIND_NAMES, ...extra].join(", ")})`);
  }
  function footprint(item, custom) {
    const kind = kindOf(item.kind, custom);
    if (!kind) unknownKind(item.kind, custom);
    const turned = item.rot === 90 || item.rot === 270;
    return { x: item.x, z: item.z, w: turned ? kind.d : kind.w, d: turned ? kind.w : kind.d };
  }
  var OP_FIELDS = {
    add: ["kind", "x", "z", "rot", "text", "color"],
    remove: ["id"],
    move: ["id", "x", "z"],
    rotate: ["id", "rot"],
    text: ["id", "text"]
  };
  var OPS = Object.freeze(Object.keys(OP_FIELDS));
  function seatOf(desk) {
    const f = footprint(desk);
    const cx = f.x + f.w / 2, cz = f.z + f.d / 2;
    const r = desk.rot * Math.PI / 180;
    const lx = 0, lz = 0.5;
    return {
      x: cx + lx * Math.cos(r) + lz * Math.sin(r),
      z: cz - lx * Math.sin(r) + lz * Math.cos(r),
      yaw: r + Math.PI
    };
  }

  // public/js/furniture.js
  var SEAT_Y = 0.46;
  var WALL_H = 2.6;
  var WOOD = "#d6a46a";
  var WOOD_D = "#8c5d3c";
  var DARK = "#2e313a";
  var WHITE = "#ffffff";
  var LEAF = ["#5fae4e", "#4f9c43", "#72c05a", "#3f8a3a"];
  var POT = "#c9744f";
  var front = { faces: [FRONT], unitUV: true };
  function chairBoxes(z, backAtPlusZ, accent) {
    const bz = backAtPlusZ ? z + 0.27 : z - 0.27;
    return {
      base: [
        vbox(0, 0.04, z, 0.08, 0.32, 0.08, DARK),
        vbox(0, 0.02, z, 0.5, 0.05, 0.08, DARK),
        vbox(0, 0.02, z, 0.08, 0.05, 0.5, DARK)
      ],
      accent: [
        vbox(0, 0.36, z, 0.56, 0.1, 0.54, accent),
        vbox(0, 0.46, bz, 0.54, 0.52, 0.08, accent),
        vbox(0, 0.58, bz + (backAtPlusZ ? -0.03 : 0.03), 0.4, 0.3, 0.04, "#e6e6e6")
      ]
    };
  }
  function leaves(cx, y, cz, s = 1) {
    return [
      vbox(cx, y, cz, 0.5 * s, 0.38 * s, 0.5 * s, LEAF[0]),
      vbox(cx + 0.12 * s, y + 0.3 * s, cz + 0.06 * s, 0.34 * s, 0.3 * s, 0.34 * s, LEAF[2]),
      vbox(cx - 0.14 * s, y + 0.22 * s, cz - 0.1 * s, 0.3 * s, 0.3 * s, 0.3 * s, LEAF[1]),
      vbox(cx + 0.02 * s, y + 0.55 * s, cz - 0.04 * s, 0.22 * s, 0.22 * s, 0.22 * s, LEAF[3])
    ];
  }
  function books(y, seed) {
    const cols = ["#e0614f", "#f0b44c", "#5b8fd9", "#7cc47a", "#b77ad6", "#f2efe6", "#2f6f73", "#e88aa6"];
    const out = [];
    let x = -0.82, i = seed;
    while (x < 0.8) {
      i = i * 1103515245 + 12345 & 2147483647;
      const w = 0.07 + i % 5 * 0.018;
      const h = 0.24 + (i >> 4) % 5 * 0.025;
      if (x + w > 0.84) break;
      if ((i >> 9) % 7 !== 0) out.push(vbox(x + w / 2, y, -0.12, w - 8e-3, h, 0.4, cols[(i >> 6) % cols.length]));
      x += w;
    }
    return out;
  }
  var MODELS = {
    desk: () => {
      const ch = chairBoxes(0.5, true, WHITE);
      return {
        defaultColor: "#6aa6c9",
        // finish (desk top) and rail (legs + modesty panel) are painted by the office theme
        finish: [vbox(0, 0.68, -0.5, 1.86, 0.07, 0.88, WHITE)],
        rail: [
          vbox(-0.86, 0, -0.5, 0.08, 0.68, 0.8, WHITE),
          vbox(0.86, 0, -0.5, 0.08, 0.68, 0.8, WHITE),
          vbox(0, 0.24, -0.88, 1.64, 0.4, 0.04, WHITE)
        ],
        base: [
          vbox(0, 0.75, -0.74, 0.3, 0.025, 0.18, DARK),
          vbox(0, 0.775, -0.75, 0.08, 0.16, 0.05, DARK),
          vbox(0, 0.88, -0.76, 0.88, 0.54, 0.06, DARK),
          vbox(0, 0.75, -0.3, 0.52, 0.03, 0.17, "#ebe7df"),
          vbox(0.4, 0.75, -0.3, 0.07, 0.03, 0.1, "#ebe7df"),
          vbox(-0.68, 0.75, -0.74, 0.16, 0.13, 0.16, POT),
          vbox(-0.68, 0.88, -0.74, 0.22, 0.14, 0.22, LEAF[2]),
          vbox(-0.66, 1, -0.72, 0.12, 0.1, 0.12, LEAF[0]),
          vbox(0.62, 0.75, -0.55, 0.1, 0.12, 0.1, "#fdfaf3"),
          vbox(0.68, 0.79, -0.55, 0.04, 0.06, 0.03, "#fdfaf3"),
          ...ch.base
        ],
        accent: ch.accent,
        glow: { boxes: [vbox(0, 0.91, -0.725, 0.8, 0.46, 0.01, WHITE, front)], tex: "screen" }
      };
    },
    chair: () => {
      const ch = chairBoxes(0, false, WHITE);
      return { defaultColor: "#e39a5b", base: ch.base, accent: ch.accent };
    },
    plant: () => ({
      defaultColor: POT,
      base: [vbox(0, 0.32, 0, 0.36, 0.04, 0.36, "#5b3d2a"), ...leaves(0, 0.36, 0)],
      accent: [vbox(0, 0, 0, 0.4, 0.34, 0.4, WHITE), vbox(0, 0.3, 0, 0.48, 0.08, 0.48, "#eeeeee")]
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
        vbox(1.36, 0.36, 0.02, 0.18, 0.24, 0.84, "#e2e2e2")
      ]
    }),
    lamp: () => ({
      defaultColor: DARK,
      base: [],
      accent: [vbox(0, 0, 0, 0.32, 0.05, 0.32, "#cccccc"), vbox(0, 0.05, 0, 0.06, 1.22, 0.06, "#cccccc")],
      glow: { boxes: [vbox(0, 1.2, 0, 0.42, 0.34, 0.42, WHITE), vbox(0, 1.54, 0, 0.3, 0.04, 0.3, WHITE)], tex: null, color: "#ffe1ad", lamp: true }
    }),
    bookshelf: () => ({
      defaultColor: WOOD_D,
      base: [0.06, 0.48, 0.9, 1.32].flatMap((y, i) => books(y, 7 + i * 13)),
      accent: [
        vbox(0, 0, -0.4, 1.9, 1.72, 0.06, "#d8d8d8"),
        vbox(-0.92, 0, -0.12, 0.08, 1.72, 0.58, WHITE),
        vbox(0.92, 0, -0.12, 0.08, 1.72, 0.58, WHITE),
        ...[0, 0.42, 0.84, 1.26, 1.66].map((y) => vbox(0, y, -0.12, 1.84, 0.06, 0.58, WHITE))
      ]
    }),
    rug: () => ({
      defaultColor: "#d98f6f",
      base: [],
      accent: [vbox(0, 0, 0, 3.8, 0.025, 5.8, WHITE, { faces: [2], unitUV: true }), vbox(0, 0, 0, 3.8, 0.025, 5.8, "#bbbbbb", { faces: [0, 1, 4, 5] })],
      accentMap: "rug",
      noShadow: true
    }),
    whiteboard: () => ({
      defaultColor: "#c9ced6",
      base: [vbox(0, 0.9, -0.38, 0.9, 0.04, 0.1, "#b6bcc6"), vbox(-0.2, 0.94, -0.36, 0.14, 0.03, 0.03, "#e0614f"), vbox(0.05, 0.94, -0.36, 0.14, 0.03, 0.03, "#3f72c8")],
      accent: [vbox(0, 0.92, -0.46, 1.84, 1, 0.07, WHITE)],
      text: { x: 0, y: 1.42, z: -0.42 + 4e-3, w: 1.72, h: 0.9, bg: "#fbfcfe", fg: "#2b4a86", tw: 256, th: 134 }
    }),
    sign: () => ({
      defaultColor: "#3a4a3f",
      base: [vbox(0, 0, 0, 0.08, 0.72, 0.08, WOOD_D), vbox(0, 0, 0, 0.36, 0.05, 0.3, WOOD_D)],
      accent: [vbox(0, 0.68, 0, 0.96, 0.6, 0.08, WHITE), vbox(0, 0.66, 0, 1, 0.04, 0.1, "#dddddd"), vbox(0, 1.28, 0, 1, 0.04, 0.1, "#dddddd")],
      text: { x: 0, y: 0.98, z: 0.044, w: 0.86, h: 0.5, bg: "#34433a", fg: "#f6f1e3", tw: 172, th: 100 }
    }),
    fridge: () => ({
      defaultColor: "#b9e2d3",
      base: [
        vbox(0.28, 1.2, 0.33, 0.05, 0.34, 0.06, "#8d979f"),
        vbox(0.28, 0.5, 0.33, 0.05, 0.3, 0.06, "#8d979f"),
        vbox(-0.15, 1.45, 0.305, 0.07, 0.07, 0.02, "#e0614f"),
        vbox(-0.02, 1.35, 0.305, 0.06, 0.08, 0.02, "#f0b44c"),
        vbox(-0.22, 1.25, 0.305, 0.12, 0.1, 0.02, "#fdfaf3")
      ],
      accent: [vbox(0, 0, -0.05, 0.78, 1.72, 0.7, WHITE), vbox(0, 1.06, 0.3, 0.8, 0.02, 0.02, "#bcbcbc")]
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
        vbox(-0.32, 0.91, -0.08, 0.1, 0.1, 0.1, "#f0b44c")
      ],
      accent: [vbox(0.05, 0.91, -0.12, 0.44, 0.48, 0.36, WHITE), vbox(0.05, 1.39, -0.12, 0.36, 0.04, 0.3, "#dddddd")],
      glow: { boxes: [vbox(0.18, 1.26, 0.061, 0.06, 0.06, 0.01, WHITE)], tex: null, color: "#8dffb5" }
    }),
    table: () => ({
      defaultColor: WOOD,
      base: [
        ...[[-0.78, -0.78], [0.78, -0.78], [-0.78, 0.78], [0.78, 0.78]].map(([x, z]) => vbox(x, 0, z, 0.1, 0.66, 0.1, WOOD_D)),
        vbox(0.2, 0.74, -0.1, 0.16, 0.18, 0.16, "#f2efe6"),
        vbox(0.2, 0.92, -0.1, 0.22, 0.12, 0.22, "#f28aa6"),
        vbox(-0.35, 0.74, 0.3, 0.12, 0.1, 0.12, "#fdfaf3")
      ],
      accent: [vbox(0, 0.66, 0, 1.84, 0.08, 1.84, WHITE)]
    }),
    tv: () => ({
      defaultColor: WOOD_D,
      base: [vbox(0, 0.44, -0.08, 0.14, 0.12, 0.06, DARK), vbox(0, 0.56, -0.09, 1.72, 0.98, 0.08, DARK)],
      accent: [vbox(0, 0, 0, 1.86, 0.44, 0.6, WHITE), vbox(-0.45, 0.06, 0.301, 0.7, 0.3, 0.01, "#e4e4e4"), vbox(0.45, 0.06, 0.301, 0.7, 0.3, 0.01, "#e4e4e4")],
      glow: { boxes: [vbox(0, 0.6, -0.04, 1.6, 0.9, 0.01, WHITE, front)], tex: "tv" }
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
        vbox(0, 0.82, -0.38, 1.9, 0.06, 0.22, "#eeeeee")
      ],
      glow: { boxes: [vbox(0, 0.94, -0.465, 1.6, 1.12, 0.01, WHITE, front)], tex: "window" },
      noShadow: true
    }),
    poster: () => ({
      defaultColor: "#f2c879",
      base: [],
      accent: [vbox(0, 1.02, -0.475, 0.74, 0.96, 0.05, WHITE)],
      text: { x: 0, y: 1.5, z: -0.45 + 4e-3, w: 0.62, h: 0.84, bg: "#fff7e6", fg: "#5a3b2a", tw: 100, th: 136, border: null }
    }),
    "server-rack": () => ({
      defaultColor: "#2a2e38",
      base: [vbox(0, 1.9, 0, 0.6, 0.03, 0.6, "#3b404d"), vbox(0, 0, 0, 0.84, 0.06, 0.84, "#1d2027")],
      accent: [vbox(0, 0.06, 0, 0.8, 1.84, 0.8, WHITE)],
      glow: { boxes: [vbox(0, 0.16, 0.401, 0.64, 1.66, 0.01, WHITE, front)], tex: "rack" }
    }),
    beanbag: () => ({
      defaultColor: "#f2a65a",
      base: [],
      accent: [
        vbox(0, 0, 0, 0.86, 0.26, 0.86, "#e6e6e6"),
        vbox(0, 0.26, 0.04, 0.74, 0.14, 0.7, WHITE),
        vbox(0, 0.26, -0.28, 0.76, 0.42, 0.26, "#f2f2f2"),
        vbox(0, 0.68, -0.3, 0.5, 0.08, 0.18, WHITE)
      ]
    })
  };
  for (const k2 of Object.keys(KINDS)) if (!MODELS[k2]) throw new Error(`furniture: no model for catalog kind "${k2}"`);
  for (const k2 of Object.keys(MODELS)) if (!KINDS[k2]) throw new Error(`furniture: model "${k2}" is not in the catalog`);

  // public/shared/theme.js
  var FLOOR_MATERIALS = Object.freeze(["wood", "tile", "concrete", "carpet"]);
  var ACCENT_WALL_MATERIALS = Object.freeze(["brick", "plaster", "wood-panels"]);
  var WALLS = Object.freeze(["back", "left"]);
  var LIGHTING = Object.freeze(["warm", "neutral", "cool"]);
  var NIGHT_WINDOWS = Object.freeze(["city", "stars", "aurora", "rain"]);
  var DEFAULT_THEME = deepFreeze({
    floor: { material: "wood", color: "#d9b086" },
    walls: { color: "#f3e6cf", trim: "#b98a5e", accent: null },
    desk: { wood: "#d6a46a", rail: "#f3ede2" },
    accents: ["#6aa6c9", "#ff8fa8", "#ffd45c"],
    lighting: "warm",
    nightWindow: "city",
    logo: null,
    logoOnSigns: false
  });
  function deepFreeze(o) {
    if (o && typeof o === "object") {
      for (const v of Object.values(o)) deepFreeze(v);
      Object.freeze(o);
    }
    return o;
  }

  // public/shared/kinds.js
  var UNITS = 16;
  var BOX_MATERIALS = Object.freeze(["matte", "glossy", "glass", "screen"]);
  var ACTIVITIES = Object.freeze(["coffee", "snack", "read", "play", "water-plants", "whiteboard", "chat", "think", "watch"]);
  var ACTIVITY_DURATION = Object.freeze({ coffee: 25, snack: 20, read: 60, play: 45, "water-plants": 15, whiteboard: 40, chat: 45, think: 30, watch: 50 });
  var CUSTOM_LAYERS = Object.freeze(["object", "floor", "wall"]);
  var fail2 = (msg) => {
    throw new OfficeError(msg);
  };
  var round2 = (v) => Math.round(v * 100) / 100;
  function spotsOf(item, custom) {
    const kind = kindOf(item.kind, custom);
    if (!kind) fail2(`unknown kind ${JSON.stringify(item.kind)}`);
    const f = footprint(item, custom);
    const cx = f.x + f.w / 2, cz = f.z + f.d / 2;
    const r = item.rot * Math.PI / 180;
    const place = (s) => {
      const ox = s.x / UNITS - kind.w / 2, oz = s.z / UNITS - kind.d / 2;
      return {
        x: round2(cx + ox * Math.cos(r) + oz * Math.sin(r)),
        z: round2(cz - ox * Math.sin(r) + oz * Math.cos(r)),
        yaw: round2((item.rot + s.rot) % 360 * Math.PI / 180)
      };
    };
    return {
      seats: (kind.seats ?? []).map((s, i) => ({ id: `${item.id}:s${i}`, item: item.id, ...place(s), height: s.height / UNITS })),
      stations: (kind.stations ?? []).map((s, i) => ({
        id: `${item.id}:t${i}`,
        item: item.id,
        ...place(s),
        activity: s.activity,
        duration: s.duration ?? ACTIVITY_DURATION[s.activity]
      }))
    };
  }
  function blockedCells(items, grid, custom) {
    const b = new Uint8Array(grid.w * grid.d);
    for (const it of items) {
      if (kindOf(it.kind, custom)?.layer !== "object") continue;
      const f = footprint(it, custom);
      for (let x = f.x; x < f.x + f.w; x++) for (let z = f.z; z < f.z + f.d; z++) {
        if (x >= 0 && z >= 0 && x < grid.w && z < grid.d) b[z * grid.w + x] = 1;
      }
    }
    return b;
  }
  function spotReachable(spot, isSeat, blocked, grid) {
    if (spot.x < 0 || spot.z < 0 || spot.x >= grid.w || spot.z >= grid.d) return false;
    if (isSeat) return true;
    return !blocked[Math.floor(spot.z) * grid.w + Math.floor(spot.x)];
  }
  function allSpots(items, custom) {
    const seats = [], stations = [];
    for (const it of items) {
      if (!kindOf(it.kind, custom)) continue;
      const s = spotsOf(it, custom);
      seats.push(...s.seats);
      stations.push(...s.stations);
    }
    return { seats, stations };
  }

  // public/js/model.js
  var CHAT_KEEP = 200;
  var D2R = Math.PI / 180;
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function requireField(frame, key) {
    if (frame[key] === void 0 || frame[key] === null) throw new Error(`frame ${frame.type} is missing "${key}"`);
    return frame[key];
  }
  function kindMap(kinds) {
    if (!Array.isArray(kinds)) throw new Error(`snapshot customKinds must be a list, got ${JSON.stringify(kinds)}`);
    return Object.fromEntries(kinds.map((k2) => [k2.kind, k2]));
  }
  function applyFrame(state2, frame) {
    if (!frame || typeof frame.type !== "string") throw new Error(`bad frame ${JSON.stringify(frame)}`);
    if (frame.type === "snapshot") {
      const s = requireField(frame, "state");
      for (const key of ["id", "grid", "items", "agents", "chat", "theme", "customKinds", "assets"]) {
        if (s[key] === void 0) throw new Error(`snapshot state is missing "${key}"`);
      }
      return {
        ...s,
        chat: s.chat.slice(-CHAT_KEEP),
        customKinds: kindMap(s.customKinds),
        designer: s.designer ?? null
      };
    }
    if (!state2) throw new Error(`frame ${frame.type} arrived before the snapshot`);
    switch (frame.type) {
      case "agent": {
        const a = requireField(frame, "agent");
        const has = state2.agents.some((x) => x.id === a.id);
        return { ...state2, agents: has ? state2.agents.map((x) => x.id === a.id ? a : x) : [...state2.agents, a] };
      }
      case "agent-left": {
        const id = requireField(frame, "id");
        return { ...state2, agents: state2.agents.filter((x) => x.id !== id) };
      }
      case "item": {
        const it = requireField(frame, "item");
        const has = state2.items.some((x) => x.id === it.id);
        return { ...state2, items: has ? state2.items.map((x) => x.id === it.id ? it : x) : [...state2.items, it] };
      }
      case "item-removed": {
        const id = requireField(frame, "id");
        return { ...state2, items: state2.items.filter((x) => x.id !== id) };
      }
      case "theme": {
        return { ...state2, theme: requireField(frame, "theme") };
      }
      case "kind": {
        const k2 = requireField(frame, "kind");
        if (typeof k2.kind !== "string") throw new Error("kind frame is missing kind.kind (the slug)");
        return { ...state2, customKinds: { ...state2.customKinds, [k2.kind]: k2 } };
      }
      case "kind-removed": {
        const slug = requireField(frame, "kind");
        const next = { ...state2.customKinds };
        delete next[slug];
        return { ...state2, customKinds: next };
      }
      case "asset": {
        const a = requireField(frame, "asset");
        return { ...state2, assets: [...state2.assets.filter((x) => x.id !== a.id), a] };
      }
      case "asset-removed": {
        const id = requireField(frame, "id");
        return { ...state2, assets: state2.assets.filter((x) => x.id !== id) };
      }
      case "designer": {
        if (!("id" in frame)) throw new Error('frame designer is missing "id"');
        return { ...state2, designer: frame.id };
      }
      case "chat": {
        const msg = requireField(frame, "msg");
        if (state2.chat.some((m) => m.id === msg.id)) return state2;
        return { ...state2, chat: [...state2.chat, msg].slice(-CHAT_KEEP) };
      }
      default:
        return state2;
    }
  }
  function poseFor(agent, hasDesk) {
    switch (agent.status) {
      case "working":
        return hasDesk ? { pose: "type", place: "desk" } : { pose: "stand", place: "lounge" };
      case "waiting":
        return hasDesk ? { pose: "handup", place: "desk" } : { pose: "wave", place: "lounge" };
      case "away":
        return hasDesk ? { pose: "doze", place: "desk" } : { pose: "stand", place: "lounge" };
      case "idle":
        return { pose: "lounge", place: "lounge" };
      default:
        throw new Error(`agent ${agent.id}: unknown status ${JSON.stringify(agent.status)}`);
    }
  }
  function deskSeating(agents, items) {
    const desks = new Map(items.filter((it) => it.kind === "desk").map((d) => [d.id, d]));
    const taken = /* @__PURE__ */ new Set();
    const out = /* @__PURE__ */ new Map();
    for (const a of [...agents].sort((x, y) => x.joinedAt - y.joinedAt || (x.id < y.id ? -1 : 1))) {
      if (!a.deskId || taken.has(a.deskId)) continue;
      const d = desks.get(a.deskId);
      if (!d) continue;
      taken.add(a.deskId);
      out.set(a.id, d);
    }
    return out;
  }
  function idleSpots(items, custom) {
    const { seats, stations } = allSpots(items, custom);
    return [
      ...seats.map((s) => ({ id: s.id, itemId: s.item, x: s.x, z: s.z, yaw: s.yaw, pose: "sit", seatY: s.height, activity: null, duration: SEAT_SECONDS })),
      ...stations.map((s) => ({ id: s.id, itemId: s.item, x: s.x, z: s.z, yaw: s.yaw, pose: s.activity, activity: s.activity, duration: s.duration }))
    ];
  }
  function usableSpots(spots, blocked, grid) {
    return spots.filter((s) => spotReachable(s, s.pose === "sit", blocked, grid));
  }
  var SEAT_SECONDS = 50;
  function wanderSalt(agentId, now) {
    const period = 3e4 + hashStr(`${agentId}:period`) % 2e4;
    return Math.floor((now + hashStr(`${agentId}:phase`) % period) / period);
  }
  function pickSpot(agentId, spots, taken, salt = 0, avoid = null) {
    if (!spots.length) return null;
    const start = hashStr(`${agentId}:${salt}`) % spots.length;
    for (let i = 0; i < spots.length; i++) {
      const s = spots[(start + i) % spots.length];
      if (!taken.has(s.id) && s.id !== avoid) return s;
    }
    return null;
  }
  function assignSpots(wanters, spots) {
    const byId = new Map(spots.map((s) => [s.id, s]));
    const taken = /* @__PURE__ */ new Set();
    const out = /* @__PURE__ */ new Map();
    const order = [...wanters].sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1));
    for (const w of order) {
      const cur = w.current ? byId.get(w.current) : null;
      if (cur && !w.restless && !taken.has(cur.id)) {
        taken.add(cur.id);
        out.set(w.id, cur);
      }
    }
    for (const w of order) {
      if (out.has(w.id)) continue;
      const avoid = w.restless ? w.current : null;
      let spot = null;
      if (hashStr(`${w.id}:chat:${w.salt}`) % 3 === 0) {
        const busy = new Set(spots.filter((s) => s.activity === "chat" && taken.has(s.id)).map((s) => s.itemId));
        spot = spots.find((s) => s.activity === "chat" && busy.has(s.itemId) && !taken.has(s.id) && s.id !== avoid) ?? null;
      }
      spot ?? (spot = pickSpot(w.id, spots, taken, w.salt, avoid));
      if (!spot) continue;
      taken.add(spot.id);
      out.set(w.id, spot);
    }
    return out;
  }
  function entryPoint(blocked, grid) {
    const tx = grid.w / 2, tz = grid.d - 0.5;
    let best = null, bd = Infinity;
    for (let z = 0; z < grid.d; z++) for (let x = 0; x < grid.w; x++) {
      if (blocked[z * grid.w + x]) continue;
      const d = Math.hypot(x + 0.5 - tx, z + 0.5 - tz);
      if (d < bd) {
        bd = d;
        best = { x: x + 0.5, z: z + 0.5 };
      }
    }
    if (!best) throw new Error("office: no walkable cell left on the floor");
    return best;
  }
  function wallOf(item, custom) {
    if (kindOf(item.kind, custom)?.layer !== "wall") return null;
    if (item.rot === 0 && item.z === 0) return "back";
    if (item.rot === 90 && item.x === 0) return "left";
    throw new Error(`item ${item.id}: ${item.kind} is not on a wall (rot ${item.rot}, x ${item.x}, z ${item.z})`);
  }
  function layoutBatches(items, custom) {
    const batches = /* @__PURE__ */ new Map();
    const texts = [];
    for (const it of items) {
      const kind = kindOf(it.kind, custom);
      if (!kind) throw new Error(`item ${it.id}: unknown kind "${it.kind}"`);
      const wall = wallOf(it, custom);
      const key = wall ? `${it.kind}@${wall}` : it.kind;
      const f = footprint(it, custom);
      const inst = { id: it.id, kind: it.kind, x: f.x + f.w / 2, z: f.z + f.d / 2, yaw: it.rot * D2R, color: it.color ?? null, wall };
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push(inst);
      if (kind.textable) texts.push({ ...inst, text: it.text ?? "" });
    }
    return { batches, texts };
  }
  function hueColors(hue) {
    const h = (Math.round(hue) % 360 + 360) % 360;
    return { shirt: `hsl(${h} 62% 58%)`, shirtDark: `hsl(${h} 52% 44%)`, accent: `hsl(${h} 80% 72%)`, css: `hsl(${h} 70% 60%)` };
  }
  function mergeBoxes(boxes) {
    let list2 = boxes.map((b) => ({ ...b }));
    const same = (a, b) => a.color.toLowerCase() === b.color.toLowerCase() && (a.material ?? "matte") === (b.material ?? "matte") && !!a.emissive === !!b.emissive;
    let changed = true;
    while (changed) {
      changed = false;
      outer: for (let i = 0; i < list2.length; i++) {
        for (let j = i + 1; j < list2.length; j++) {
          const a = list2[i], b = list2[j];
          if (!same(a, b)) continue;
          let m = null;
          if (a.y === b.y && a.h === b.h && a.z === b.z && a.d === b.d && (a.x + a.w === b.x || b.x + b.w === a.x)) m = { ...a, x: Math.min(a.x, b.x), w: a.w + b.w };
          else if (a.x === b.x && a.w === b.w && a.z === b.z && a.d === b.d && (a.y + a.h === b.y || b.y + b.h === a.y)) m = { ...a, y: Math.min(a.y, b.y), h: a.h + b.h };
          else if (a.x === b.x && a.w === b.w && a.y === b.y && a.h === b.h && (a.z + a.d === b.z || b.z + b.d === a.z)) m = { ...a, z: Math.min(a.z, b.z), d: a.d + b.d };
          if (m) {
            list2[i] = m;
            list2.splice(j, 1);
            changed = true;
            break outer;
          }
        }
      }
    }
    return list2;
  }
  function kindGeometryPlan(def) {
    if (!def || !Number.isInteger(def.w) || !Number.isInteger(def.d) || !Array.isArray(def.boxes)) throw new Error(`custom kind ${JSON.stringify(def?.kind)} has no w/d/boxes`);
    const U = UNITS;
    const fw = def.w, fd = def.d;
    const merged = mergeBoxes(def.boxes);
    const plan = { matte: [], glossy: [], glass: [], screen: [], emissive: [], input: def.boxes.length, merged: merged.length };
    for (const b of merged) {
      const mat = b.material ?? "matte";
      if (!BOX_MATERIALS.includes(mat)) throw new Error(`custom kind ${def.kind}: unknown box material ${JSON.stringify(mat)}`);
      const out = { cx: (b.x + b.w / 2) / U - fw / 2, y0: b.y / U, cz: (b.z + b.d / 2) / U - fd / 2, w: b.w / U, h: b.h / U, d: b.d / U, color: b.color };
      const bucket = mat === "screen" ? "screen" : b.emissive ? "emissive" : mat;
      plan[bucket].push(out);
    }
    return plan;
  }
  var MOODS = Object.freeze({
    warm: { sun: "#ffe4bd", sky: "#d7ecff", ground: "#e3c39d", lamp: "#ffc27a", fill: "#ffd9a8", nightSky: "#41508f" },
    neutral: { sun: "#fff3e4", sky: "#e2ecf8", ground: "#d6cfc6", lamp: "#ffe0b8", fill: "#ffe9cf", nightSky: "#45507f" },
    cool: { sun: "#eef3ff", sky: "#d2e4ff", ground: "#c4cfd9", lamp: "#d6e6ff", fill: "#dfe9ff", nightSky: "#3f5a96" }
  });
  var CLASSIC_COLORS = Object.freeze({ desk: "#6aa6c9", chair: "#e39a5b", sofa: "#6f9fc0", beanbag: "#f2a65a", rug: "#d98f6f", sign: "#3a4a3f", lamp: "#2e313a", poster: "#f2c879" });

  // public/js/character.js
  var LEG_H = 0.4;
  var BODY_H = 0.46;
  var HEAD = 0.46;
  var CROWN = LEG_H + BODY_H + HEAD + 0.06;
  var SKINS = ["#f6d3b3", "#eabf98", "#d9a27a", "#b97d55", "#8d5a3b", "#f3c9a5"];
  var HAIRS = ["#3a2a22", "#6b4630", "#d9a35a", "#1f1f27", "#a8442e", "#e7d3a1", "#5a6cc4", "#f08bb0"];
  var PANTS = ["#3d4a66", "#4a4f5c", "#5b4a3f", "#34495e", "#6b5b7b"];
  var STYLES = ["crop", "bob", "bun", "spiky", "cap"];
  function lookFor(agent) {
    const h = hashStr(agent.id || agent.name);
    return {
      skin: SKINS[h % SKINS.length],
      hair: HAIRS[(h >>> 4) % HAIRS.length],
      pants: PANTS[(h >>> 8) % PANTS.length],
      style: STYLES[(h >>> 12) % STYLES.length],
      ...hueColors(agent.hue ?? 0)
    };
  }

  // tvos/bridge/entry.js
  var state = null;
  var boxesOf = (list2) => (list2 ?? []).map((b) => ({ at: b.at, size: b.size, color: b.color }));
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
          { role: "glow", boxes: boxesOf(m.glow?.boxes) }
        ].filter((p) => p.boxes.length)
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
        { role: "glow", boxes: [...plan.screen, ...plan.emissive].map(toBox) }
      ].filter((p) => p.boxes.length)
    };
  }
  function targets(now) {
    const custom = state.customKinds ?? {};
    const seating = deskSeating(state.agents, state.items);
    const blocked = blockedCells(state.items, state.grid, custom);
    const spots = usableSpots(idleSpots(state.items, custom), blocked, state.grid);
    const entry = entryPoint(blocked, state.grid);
    const chosen = /* @__PURE__ */ new Map();
    for (const a of state.agents) {
      if (a.at === "desk" && seating.has(a.id)) chosen.set(a.id, "desk");
      else if (a.at) {
        const s = spots.find((x) => x.id === a.at);
        if (s) chosen.set(a.id, s);
      }
    }
    const free = spots.filter((s) => ![...chosen.values()].includes(s));
    const wanters = state.agents.filter((a) => !chosen.has(a.id) && poseFor(a, seating.has(a.id)).place === "lounge").map((a) => ({ id: a.id, joinedAt: a.joinedAt, salt: wanderSalt(a.id, now), current: null, restless: false }));
    const assign = assignSpots(wanters, free);
    const out = /* @__PURE__ */ new Map();
    for (const a of state.agents) {
      const desk = seating.get(a.id);
      const pick = chosen.get(a.id);
      const { pose, place } = poseFor(a, !!desk);
      if (pick === "desk" || place === "desk" && desk && !pick) {
        const s = seatOf(desk);
        out.set(a.id, { key: `desk:${desk.id}`, x: s.x, z: s.z, yaw: s.yaw, pose: pick === "desk" && a.status === "idle" ? "sit" : pose, seatY: SEAT_Y });
        continue;
      }
      const spot = pick && pick !== "desk" ? pick : assign.get(a.id) ?? null;
      if (spot) {
        out.set(a.id, { key: `spot:${spot.id}`, x: spot.x, z: spot.z, yaw: spot.yaw, pose: pose === "wave" ? "wave" : spot.pose, seatY: spot.seatY ?? SEAT_Y });
        continue;
      }
      const h = hashStr(a.id + wanderSalt(a.id, now));
      out.set(a.id, { key: `mill:${h % 97}`, x: entry.x + (h % 5 - 2) * 0.9, z: Math.max(0.5, entry.z - 1 - (h >> 3) % 3 * 0.9), yaw: Math.PI, pose: "stand", seatY: SEAT_Y });
    }
    return out;
  }
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
          id: a.id,
          name: a.name,
          status: a.status,
          activity: a.activity ?? null,
          hue: a.hue,
          look: lookFor(a),
          target: t.get(a.id)
        })),
        chat: state.chat.slice(-6).map((m) => ({ from: nameOf(m.from), to: m.to ? nameOf(m.to) : null, text: m.text, ts: m.ts }))
      });
    }
  };
})();
