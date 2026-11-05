"use strict";
(() => {
  // tvos/bridge/three-stub.js
  var toLinear = (c) => c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
  var toSRGB = (c) => c < 31308e-7 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055;
  var Color = class {
    constructor(hex) {
      this.r = 0;
      this.g = 0;
      this.b = 0;
      if (hex !== void 0) this.set(hex);
    }
    set(hex) {
      const hsl = /^hsl\(\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)%\s*,\s*(\d*\.?\d+)%\s*\)$/.exec(hex);
      if (hsl) return this.setHSL(+hsl[1] / 360, +hsl[2] / 100, +hsl[3] / 100);
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      if (!m) throw new Error(`three-stub Color: only #rrggbb and hsl(h, s%, l%) are supported, got ${JSON.stringify(hex)}`);
      const n = parseInt(m[1], 16);
      this.r = toLinear((n >> 16) / 255);
      this.g = toLinear((n >> 8 & 255) / 255);
      this.b = toLinear((n & 255) / 255);
      return this;
    }
    setHSL(h, s, l) {
      h = (h % 1 + 1) % 1;
      const q = l <= 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      const hue = (t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
        return p;
      };
      this.r = toLinear(hue(h + 1 / 3));
      this.g = toLinear(hue(h));
      this.b = toLinear(hue(h - 1 / 3));
      return this;
    }
    multiplyScalar(f) {
      this.r *= f;
      this.g *= f;
      this.b *= f;
      return this;
    }
    getHexString() {
      const h = (v) => Math.round(Math.max(0, Math.min(1, toSRGB(v))) * 255).toString(16).padStart(2, "0");
      return h(this.r) + h(this.g) + h(this.b);
    }
  };
  var Float32BufferAttribute = class {
    constructor(array, itemSize) {
      this.array = array;
      this.itemSize = itemSize;
    }
  };
  var BufferGeometry = class {
    constructor() {
      this.attributes = {};
      this.index = null;
    }
    setAttribute(name, attr) {
      this.attributes[name] = attr;
    }
    setIndex(idx) {
      this.index = idx;
    }
    computeBoundingSphere() {
    }
    computeBoundingBox() {
    }
  };
  var CanvasTexture = class {
    constructor(canvas2) {
      this.image = canvas2;
    }
  };
  var NearestFilter = 1003;
  var NearestMipmapLinearFilter = 1005;
  var RepeatWrapping = 1e3;
  var SRGBColorSpace = "srgb";

  // public/js/voxel.js
  var FACES = [
    { n: [1, 0, 0], corners: [[1, 0, 1], [1, 0, 0], [1, 1, 1], [1, 1, 0]], uv: [2, 1], flipU: true },
    { n: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1]], uv: [2, 1] },
    { n: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [0, 1, 0], [1, 1, 0]], uv: [0, 2] },
    { n: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]], uv: [0, 2] },
    { n: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], uv: [0, 1] },
    { n: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0]], uv: [0, 1], flipU: true }
  ];
  var FRONT = 4;
  function vbox(cx, y0, cz, w, h, d, color2, extra = {}) {
    return { at: [cx, y0, cz], size: [w, h, d], color: color2, ...extra };
  }
  function inside(p, b, eps) {
    const [cx, y0, cz] = b.at, [w, h, d] = b.size;
    return p[0] >= cx - w / 2 - eps && p[0] <= cx + w / 2 + eps && p[1] >= y0 - eps && p[1] <= y0 + h + eps && p[2] >= cz - d / 2 - eps && p[2] <= cz + d / 2 + eps;
  }
  function buildGeometry(boxes, { ao = true, floorY = 0 } = {}) {
    const pos = [], nor = [], col = [], uv = [], idx = [];
    const c = new Color();
    let v = 0;
    for (const [bi, b] of boxes.entries()) {
      const [cx, y0, cz] = b.at, [w, h, d] = b.size;
      const min = [cx - w / 2, y0, cz - d / 2], size = [w, h, d];
      c.set(b.color);
      const faces = b.faces ?? [0, 1, 2, 3, 4, 5];
      for (const fi of faces) {
        const F = FACES[fi];
        for (const corner of F.corners) {
          const p = [min[0] + corner[0] * size[0], min[1] + corner[1] * size[1], min[2] + corner[2] * size[2]];
          pos.push(p[0], p[1], p[2]);
          nor.push(...F.n);
          let k2 = 1;
          if (ao) {
            if (p[1] <= floorY + 0.015) k2 *= 0.62;
            else if (p[1] <= floorY + 0.12) k2 *= 0.82;
            for (const [oj, o] of boxes.entries()) {
              if (oj === bi || o.unitUV) continue;
              if (inside(p, o, 0.012)) {
                k2 *= 0.74;
                break;
              }
            }
            if (F.n[1] === -1) k2 *= 0.8;
          }
          col.push(c.r * k2, c.g * k2, c.b * k2);
          if (b.unitUV) {
            let u = corner[F.uv[0]], vv = corner[F.uv[1]];
            if (F.flipU) u = 1 - u;
            uv.push(u, vv);
          } else {
            let u = p[F.uv[0]], vv = p[F.uv[1]];
            if (F.flipU) u = -u;
            uv.push(u, vv);
          }
        }
        idx.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
        v += 4;
      }
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new Float32BufferAttribute(nor, 3));
    g.setAttribute("color", new Float32BufferAttribute(col, 3));
    g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
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
  var ACCENTS_MAX = 4;
  var ASSET_ID_RE = /^a[0-9a-f]{23}$/;
  var COLOR_RE = /^#[0-9a-fA-F]{6}$/;
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
  var ThemeError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "ThemeError";
    }
  };
  var fail2 = (msg) => {
    throw new ThemeError(msg);
  };
  function deepFreeze(o) {
    if (o && typeof o === "object") {
      for (const v of Object.values(o)) deepFreeze(v);
      Object.freeze(o);
    }
    return o;
  }
  var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  function onlyKeys(obj, allowed, where) {
    for (const k2 of Object.keys(obj)) if (!allowed.includes(k2)) fail2(`${where} has unknown field "${k2}" (allowed: ${allowed.join(", ")})`);
  }
  function color(v, where) {
    if (typeof v !== "string" || !COLOR_RE.test(v)) fail2(`${where} must be a #rrggbb colour, got ${JSON.stringify(v)}`);
    return v.toLowerCase();
  }
  function oneOf(v, list2, where) {
    if (!list2.includes(v)) fail2(`${where} must be one of ${list2.join(", ")}, got ${JSON.stringify(v)}`);
    return v;
  }
  function validateTheme(t) {
    if (!isObj(t)) fail2("theme is not an object");
    onlyKeys(t, Object.keys(DEFAULT_THEME), "theme");
    for (const k2 of Object.keys(DEFAULT_THEME)) if (!Object.hasOwn(t, k2)) fail2(`theme is missing "${k2}"`);
    if (!isObj(t.floor)) fail2("theme.floor must be {material, color}");
    onlyKeys(t.floor, ["material", "color"], "theme.floor");
    if (!isObj(t.walls)) fail2("theme.walls must be {color, trim, accent}");
    onlyKeys(t.walls, ["color", "trim", "accent"], "theme.walls");
    let accent = null;
    if (t.walls.accent !== null) {
      if (!isObj(t.walls.accent)) fail2("theme.walls.accent must be null or {material, color, wall}");
      onlyKeys(t.walls.accent, ["material", "color", "wall"], "theme.walls.accent");
      accent = {
        material: oneOf(t.walls.accent.material, ACCENT_WALL_MATERIALS, "theme.walls.accent.material"),
        color: color(t.walls.accent.color, "theme.walls.accent.color"),
        wall: oneOf(t.walls.accent.wall, WALLS, "theme.walls.accent.wall")
      };
    }
    if (!isObj(t.desk)) fail2("theme.desk must be {wood, rail}");
    onlyKeys(t.desk, ["wood", "rail"], "theme.desk");
    if (!Array.isArray(t.accents) || t.accents.length < 1 || t.accents.length > ACCENTS_MAX) fail2(`theme.accents must be 1-${ACCENTS_MAX} colours`);
    if (t.logo !== null && (typeof t.logo !== "string" || !ASSET_ID_RE.test(t.logo))) fail2(`theme.logo must be null or an asset id from office_upload, got ${JSON.stringify(t.logo)}`);
    if (typeof t.logoOnSigns !== "boolean") fail2("theme.logoOnSigns must be true or false");
    return {
      floor: { material: oneOf(t.floor.material, FLOOR_MATERIALS, "theme.floor.material"), color: color(t.floor.color, "theme.floor.color") },
      walls: { color: color(t.walls.color, "theme.walls.color"), trim: color(t.walls.trim, "theme.walls.trim"), accent },
      desk: { wood: color(t.desk.wood, "theme.desk.wood"), rail: color(t.desk.rail, "theme.desk.rail") },
      accents: t.accents.map((c, i) => color(c, `theme.accents[${i}]`)),
      lighting: oneOf(t.lighting, LIGHTING, "theme.lighting"),
      nightWindow: oneOf(t.nightWindow, NIGHT_WINDOWS, "theme.nightWindow"),
      logo: t.logo,
      logoOnSigns: t.logoOnSigns
    };
  }
  function hexToRgb(hex) {
    color(hex, "colour");
    const n = parseInt(hex.slice(1), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  function rgbToHex([r, g, b]) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return `#${c(r)}${c(g)}${c(b)}`;
  }
  function mixHex(a, b, t) {
    const pa = hexToRgb(a), pb = hexToRgb(b);
    return rgbToHex(pa.map((v, i) => v + (pb[i] - v) * t));
  }
  function hexToHsl(hex) {
    const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToHex([h, s, l]) {
    const hue = (h % 360 + 360) % 360 / 360;
    const sat = Math.max(0, Math.min(1, s)), lig = Math.max(0, Math.min(1, l));
    if (sat === 0) return rgbToHex([lig * 255, lig * 255, lig * 255]);
    const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
    const p = 2 * lig - q;
    const ch = (t) => {
      const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
      if (u < 1 / 6) return p + (q - p) * 6 * u;
      if (u < 1 / 2) return q;
      if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
      return p;
    };
    return rgbToHex([ch(hue + 1 / 3) * 255, ch(hue) * 255, ch(hue - 1 / 3) * 255]);
  }
  function luminance(hex) {
    const lin = hexToRgb(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  // public/shared/kinds.js
  var UNITS = 16;
  var BOX_MATERIALS = Object.freeze(["matte", "glossy", "glass", "screen"]);
  var ACTIVITIES = Object.freeze(["coffee", "snack", "read", "play", "water-plants", "whiteboard", "chat", "think", "watch"]);
  var ACTIVITY_DURATION = Object.freeze({ coffee: 25, snack: 20, read: 60, play: 45, "water-plants": 15, whiteboard: 40, chat: 45, think: 30, watch: 50 });
  var CUSTOM_LAYERS = Object.freeze(["object", "floor", "wall"]);
  var fail3 = (msg) => {
    throw new OfficeError(msg);
  };
  var round2 = (v) => Math.round(v * 100) / 100;
  function spotsOf(item, custom) {
    const kind = kindOf(item.kind, custom);
    if (!kind) fail3(`unknown kind ${JSON.stringify(item.kind)}`);
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
  var SEATED = /* @__PURE__ */ new Set(["type", "handup", "doze", "sit"]);
  function limbAngles(pose, t, phase = 0) {
    const a = { legL: 0, legR: 0, armL: 0, armR: 0, armLz: 0, armRz: 0, head: 0, headTilt: 0, lean: 0, bob: 0, seated: false };
    const s = t + phase;
    if (pose === "walk") {
      const w = Math.sin(s * 9);
      a.legL = 38 * D2R * w;
      a.legR = -38 * D2R * w;
      a.armL = -32 * D2R * w;
      a.armR = 32 * D2R * w;
      a.bob = Math.abs(Math.cos(s * 9)) * 0.05;
      return a;
    }
    if (SEATED.has(pose)) {
      a.seated = true;
      a.legL = a.legR = -88 * D2R;
      a.bob = Math.sin(s * 2) * 6e-3;
      if (pose === "type") {
        a.armL = -72 * D2R + Math.sin(s * 14) * 7 * D2R;
        a.armR = -72 * D2R + Math.sin(s * 14 + Math.PI) * 7 * D2R;
        a.lean = 7 * D2R;
        a.head = Math.sin(s * 0.45) * 7 * D2R;
        a.headTilt = 6 * D2R + Math.max(0, Math.sin(s * 0.9)) * 4 * D2R;
      } else if (pose === "handup") {
        a.armL = -45 * D2R;
        a.armR = -170 * D2R;
        a.armRz = Math.sin(s * 5) * 14 * D2R;
        a.head = Math.sin(s * 0.8) * 18 * D2R;
        a.headTilt = -6 * D2R;
      } else if (pose === "doze") {
        a.armL = a.armR = -55 * D2R;
        a.lean = 22 * D2R;
        a.headTilt = 24 * D2R + Math.sin(s * 1.2) * 3 * D2R;
      } else {
        a.armL = a.armR = -18 * D2R;
        a.head = Math.sin(s * 0.3) * 25 * D2R;
      }
      return a;
    }
    if (pose === "sip" || pose === "coffee") {
      const lift = Math.max(0, Math.sin(s * 0.9)) ** 3;
      a.armR = (-55 - 70 * lift) * D2R;
      a.armRz = 14 * D2R;
      a.armL = Math.sin(s * 1.1) * 3 * D2R;
      a.headTilt = (-14 * lift + 3) * D2R;
      a.head = Math.sin(s * 0.3) * 12 * D2R * (1 - lift);
      a.bob = Math.sin(s * 2) * 8e-3;
      return a;
    }
    if (pose === "snack") {
      const bite = Math.max(0, Math.sin(s * 2.2)) ** 2;
      a.armL = (-60 - 60 * bite) * D2R;
      a.armLz = 16 * D2R;
      a.headTilt = (-4 + 6 * bite) * D2R;
      a.bob = Math.sin(s * 4.4) * 6e-3 * bite;
      return a;
    }
    if (pose === "read") {
      a.armL = a.armR = -62 * D2R;
      a.armLz = a.armRz = 12 * D2R;
      a.headTilt = 22 * D2R;
      const turn = Math.max(0, Math.sin(s * 0.55) - 0.9) * 10;
      a.armRz = (12 + 30 * turn) * D2R;
      a.head = Math.sin(s * 0.7) * 4 * D2R;
      a.bob = Math.sin(s * 1.6) * 6e-3;
      return a;
    }
    if (pose === "play") {
      a.armL = -78 * D2R + Math.sin(s * 17) * 6 * D2R;
      a.armR = -80 * D2R + Math.sin(s * 23 + 1) * 9 * D2R;
      a.armLz = Math.sin(s * 5) * 8 * D2R;
      a.lean = (8 + Math.sin(s * 3) * 3) * D2R;
      a.head = Math.sin(s * 1.3) * 3 * D2R;
      a.headTilt = 4 * D2R;
      a.bob = Math.abs(Math.sin(s * 6)) * 0.02;
      return a;
    }
    if (pose === "water-plants") {
      a.armR = (-70 + Math.sin(s * 1.2) * 14) * D2R;
      a.armRz = 6 * D2R;
      a.armL = Math.sin(s * 1.1) * 3 * D2R;
      a.lean = 10 * D2R;
      a.headTilt = 18 * D2R;
      a.bob = Math.sin(s * 2) * 8e-3;
      return a;
    }
    if (pose === "whiteboard") {
      a.armR = (-128 + Math.sin(s * 7) * 6) * D2R;
      a.armRz = Math.sin(s * 0.9) * 22 * D2R;
      a.armL = Math.sin(s * 0.8) * 4 * D2R;
      a.head = Math.sin(s * 0.9) * 10 * D2R;
      a.headTilt = -8 * D2R;
      a.bob = Math.sin(s * 2) * 6e-3;
      return a;
    }
    if (pose === "chat") {
      const talk = Math.sin(s * 0.6) > 0;
      a.armL = (talk ? -35 + Math.sin(s * 4) * 18 : 0) * D2R;
      a.armLz = 10 * D2R;
      a.armR = (talk ? -25 + Math.sin(s * 3 + 1) * 14 : 0) * D2R;
      a.headTilt = (talk ? -3 : Math.sin(s * 5) * 6) * D2R;
      a.head = Math.sin(s * 0.4) * 8 * D2R;
      a.bob = Math.sin(s * 2) * 8e-3;
      return a;
    }
    if (pose === "think") {
      a.armR = -128 * D2R;
      a.armRz = -30 * D2R;
      a.armL = -40 * D2R;
      a.armLz = -24 * D2R;
      a.headTilt = (-14 + Math.sin(s * 0.5) * 5) * D2R;
      a.head = Math.sin(s * 0.35) * 18 * D2R;
      a.lean = Math.sin(s * 0.4) * 2 * D2R;
      a.bob = Math.sin(s * 1.2) * 6e-3;
      return a;
    }
    if (pose === "watch") {
      const laugh = Math.max(0, Math.sin(s * 0.7) - 0.85) * 6;
      a.armL = a.armR = -70 * D2R;
      a.armLz = -38 * D2R;
      a.armRz = -38 * D2R;
      a.headTilt = (-4 - laugh * 8) * D2R;
      a.head = Math.sin(s * 0.25) * 6 * D2R;
      a.lean = -3 * D2R;
      a.bob = Math.sin(s * 2) * 6e-3 + Math.abs(Math.sin(s * 14)) * 0.02 * laugh;
      return a;
    }
    if (pose === "wave") {
      a.armR = -168 * D2R;
      a.armRz = Math.sin(s * 8) * 26 * D2R;
      a.bob = Math.sin(s * 2) * 8e-3;
      return a;
    }
    a.bob = Math.sin(s * 2) * 8e-3;
    a.armL = Math.sin(s * 1.1) * 3 * D2R;
    a.armR = -a.armL;
    a.head = Math.max(0, Math.sin(s * 0.5) - 0.6) * 70 * D2R * (Math.sin(s * 0.17) > 0 ? 1 : -1);
    return a;
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
  var cellOf = (p, grid) => ({ x: Math.min(grid.w - 1, Math.max(0, Math.floor(p.x))), z: Math.min(grid.d - 1, Math.max(0, Math.floor(p.z))) });
  function route(blocked, grid, from, to) {
    const W = grid.w, D = grid.d;
    const s = cellOf(from, grid), g = cellOf(to, grid);
    const si = s.z * W + s.x, gi = g.z * W + g.x;
    const free = (x, z) => x >= 0 && z >= 0 && x < W && z < D && (!blocked[z * W + x] || z * W + x === gi || z * W + x === si);
    const gScore = new Float32Array(W * D).fill(Infinity);
    const came = new Int32Array(W * D).fill(-1);
    const closed = new Uint8Array(W * D);
    const h = (i) => Math.hypot(i % W - g.x, Math.floor(i / W) - g.z);
    const open = [si];
    gScore[si] = 0;
    const f = new Float32Array(W * D).fill(Infinity);
    f[si] = h(si);
    let found = si === gi;
    while (open.length && !found) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      const cur = open[bi];
      open[bi] = open[open.length - 1];
      open.pop();
      if (cur === gi) {
        found = true;
        break;
      }
      closed[cur] = 1;
      const cx = cur % W, cz = Math.floor(cur / W);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (!free(nx, nz)) continue;
        if (dx && dz && (!free(cx + dx, cz) || !free(cx, cz + dz))) continue;
        const ni = nz * W + nx;
        if (closed[ni]) continue;
        const ng = gScore[cur] + (dx && dz ? Math.SQRT2 : 1);
        if (ng < gScore[ni]) {
          gScore[ni] = ng;
          came[ni] = cur;
          f[ni] = ng + h(ni);
          if (!open.includes(ni)) open.push(ni);
        }
      }
    }
    if (!found) return [{ x: to.x, z: to.z }];
    const cells = [];
    for (let i = gi; i !== -1 && i !== si; i = came[i]) cells.push(i);
    cells.reverse();
    const pts = cells.slice(0, -1).map((i) => ({ x: i % W + 0.5, z: Math.floor(i / W) + 0.5 }));
    pts.push({ x: to.x, z: to.z });
    return smooth([{ x: from.x, z: from.z }, ...pts], blocked, grid, si, gi).slice(1);
  }
  function smooth(pts, blocked, grid, si, gi) {
    if (pts.length < 3) return pts;
    const W = grid.w;
    const clear = (a, b) => {
      const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * 4);
      for (let k2 = 1; k2 < n; k2++) {
        const x = a.x + (b.x - a.x) * k2 / n, z = a.z + (b.z - a.z) * k2 / n;
        for (const [ox, oz] of [[0.22, 0.22], [-0.22, 0.22], [0.22, -0.22], [-0.22, -0.22]]) {
          const cx = Math.floor(x + ox), cz = Math.floor(z + oz);
          if (cx < 0 || cz < 0 || cx >= W || cz >= grid.d) return false;
          const i2 = cz * W + cx;
          if (blocked[i2] && i2 !== si && i2 !== gi) return false;
        }
      }
      return true;
    };
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !clear(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
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
  function labelPriority({ selected, status, speaking }) {
    if (selected) return 100;
    if (speaking) return 60;
    return { waiting: 50, working: 40, idle: 20, away: 10 }[status] ?? 0;
  }
  function cullLabels(rects) {
    const sorted = [...rects].sort((a, b) => b.priority - a.priority || (a.depth ?? 0) - (b.depth ?? 0));
    const kept = [];
    for (const r of sorted) {
      const hit = kept.some((k2) => r.x < k2.x + k2.w && r.x + r.w > k2.x && r.y < k2.y + k2.h && r.y + r.h > k2.y);
      if (!hit) kept.push(r);
    }
    return new Set(kept.map((r) => r.id));
  }
  function hueColors(hue) {
    const h = (Math.round(hue) % 360 + 360) % 360;
    return { shirt: `hsl(${h}, 62%, 58%)`, shirtDark: `hsl(${h}, 52%, 44%)`, accent: `hsl(${h}, 80%, 72%)`, css: `hsl(${h}, 70%, 60%)` };
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
  var FLOOR_ROUGH = { wood: 0.78, tile: 0.5, concrete: 0.62, carpet: 1 };
  var CLASSIC_COLORS = Object.freeze({ desk: "#6aa6c9", chair: "#e39a5b", sofa: "#6f9fc0", beanbag: "#f2a65a", rug: "#d98f6f", sign: "#3a4a3f", lamp: "#2e313a", poster: "#f2c879" });
  var sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  function themeLook(theme) {
    const t = validateTheme(theme);
    const classic = sameList(t.accents, DEFAULT_THEME.accents);
    const a = (i) => t.accents[i % t.accents.length];
    const soft = (hex, l = 0.62) => {
      const [h, s] = hexToHsl(hex);
      return hslToHex([h, Math.min(s, 0.55), l]);
    };
    const darkest = [...t.accents].sort((x, y) => luminance(x) - luminance(y))[0];
    const ink = luminance(darkest) < 0.06 ? darkest : hslToHex([hexToHsl(a(0))[0], 0.25, 0.1]);
    const kindColors = classic ? { ...CLASSIC_COLORS } : {
      desk: a(0),
      chair: a(0),
      sofa: soft(a(0), 0.5),
      beanbag: a(1),
      rug: soft(a(1), 0.66),
      sign: ink,
      lamp: ink,
      poster: soft(a(1), 0.8)
    };
    return {
      floor: { material: t.floor.material, color: t.floor.color, roughness: FLOOR_ROUGH[t.floor.material] },
      walls: { color: t.walls.color, trim: t.walls.trim, baseboard: mixHex(t.walls.color, t.walls.trim, 0.25), accent: t.walls.accent },
      desk: { wood: t.desk.wood, rail: t.desk.rail },
      kindColors,
      mood: MOODS[t.lighting],
      nightWindow: t.nightWindow,
      signBg: classic ? "#34433a" : ink,
      signFg: classic ? "#f6f1e3" : mixHex("#ffffff", a(1), 0.12),
      screenBg: classic ? "#18233a" : ink,
      logo: t.logo,
      logoOnSigns: t.logoOnSigns
    };
  }

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
  function hairBoxes(style, hair, accent) {
    const H = HEAD, top = H;
    const b = [];
    if (style === "cap") {
      b.push(vbox(0, top - 0.1, 0, H + 0.04, 0.16, H + 0.04, accent));
      b.push(vbox(0, top - 0.1, H / 2 + 0.1, H * 0.8, 0.04, 0.22, accent));
      b.push(vbox(0, top - 0.24, -0.02, H + 0.03, 0.14, H - 0.02, hair));
      return b;
    }
    b.push(vbox(0, top - 0.08, 0, H + 0.04, 0.12, H + 0.04, hair));
    b.push(vbox(0, top - 0.3, -H / 2 + 0.03, H + 0.04, 0.24, 0.1, hair));
    if (style === "crop") {
      b.push(vbox(0, top - 0.14, H / 2 - 0.02, H + 0.04, 0.08, 0.06, hair));
    } else if (style === "bob") {
      b.push(vbox(-H / 2 - 0.01, top - 0.38, 0, 0.06, 0.34, H + 0.02, hair));
      b.push(vbox(H / 2 + 0.01, top - 0.38, 0, 0.06, 0.34, H + 0.02, hair));
      b.push(vbox(0, top - 0.42, -H / 2 + 0.03, H + 0.06, 0.34, 0.1, hair));
      b.push(vbox(0.08, top - 0.16, H / 2, H * 0.7, 0.1, 0.06, hair));
    } else if (style === "bun") {
      b.push(vbox(0, top + 0.02, -0.08, 0.2, 0.16, 0.2, hair));
      b.push(vbox(0, top - 0.14, H / 2 - 0.02, H + 0.04, 0.08, 0.06, hair));
    } else if (style === "spiky") {
      for (const [x, z, s] of [[-0.12, 0.08, 0.12], [0.1, 0.1, 0.1], [0, -0.08, 0.14], [0.14, -0.1, 0.1], [-0.14, -0.12, 0.1]]) {
        b.push(vbox(x, top + 0.02, z, s, s, s, hair));
      }
      b.push(vbox(0, top - 0.14, H / 2 - 0.02, H + 0.04, 0.08, 0.06, hair));
    }
    return b;
  }
  function faceBoxes(look) {
    const z = HEAD / 2 + 5e-3;
    return [
      vbox(-0.11, 0.255, z, 0.1, 0.03, 0.01, look.hair, { faces: [4] }),
      vbox(0.11, 0.255, z, 0.1, 0.03, 0.01, look.hair, { faces: [4] }),
      vbox(-0.175, 0.1, z, 0.07, 0.04, 0.01, "#f29a9a", { faces: [4] }),
      vbox(0.175, 0.1, z, 0.07, 0.04, 0.01, "#f29a9a", { faces: [4] }),
      vbox(0, 0.075, z, 0.08, 0.025, 0.01, "#9c4f45", { faces: [4] })
    ];
  }
  function characterRig(agent) {
    const look = lookFor(agent);
    const parts = {
      hips: { parent: null, at: [0, LEG_H, 0], boxes: [] },
      legL: { parent: "hips", at: [0.105, 0, 0], boxes: [vbox(0, -LEG_H + 0.08, 0, 0.19, LEG_H - 0.08, 0.2, look.pants), vbox(0, -LEG_H, 0.02, 0.2, 0.09, 0.24, "#2b2b33")] },
      legR: { parent: "hips", at: [-0.105, 0, 0], boxes: [vbox(0, -LEG_H + 0.08, 0, 0.19, LEG_H - 0.08, 0.2, look.pants), vbox(0, -LEG_H, 0.02, 0.2, 0.09, 0.24, "#2b2b33")] },
      torso: {
        parent: "hips",
        at: [0, 0, 0],
        boxes: [
          vbox(0, 0, 0, 0.42, BODY_H, 0.24, look.shirt),
          vbox(0, BODY_H - 0.06, 5e-3, 0.18, 0.06, 0.245, look.skin),
          vbox(0, 0, 5e-3, 0.43, 0.06, 0.245, look.shirtDark),
          vbox(0.11, 0.3, 0.121, 0.08, 0.08, 0.01, look.accent, { faces: [4] })
        ]
      },
      head: { parent: "torso", at: [0, BODY_H, 0], boxes: [vbox(0, 0, 0, HEAD, HEAD, HEAD, look.skin), ...hairBoxes(look.style, look.hair, look.shirt)], face: faceBoxes(look) },
      eyes: {
        parent: "head",
        at: [0, 0.185, 0],
        boxes: [
          vbox(-0.11, 0.14 - 0.185, HEAD / 2 + 6e-3, 0.08, 0.09, 0.01, "#25222b", { faces: [4] }),
          vbox(0.11, 0.14 - 0.185, HEAD / 2 + 6e-3, 0.08, 0.09, 0.01, "#25222b", { faces: [4] }),
          vbox(-0.09, 0.19 - 0.185, HEAD / 2 + 8e-3, 0.03, 0.03, 0.01, "#ffffff", { faces: [4] }),
          vbox(0.13, 0.19 - 0.185, HEAD / 2 + 8e-3, 0.03, 0.03, 0.01, "#ffffff", { faces: [4] })
        ]
      },
      armL: { parent: "torso", at: [0.29, BODY_H - 0.06, 0], boxes: [vbox(0, -0.2, 0, 0.15, 0.24, 0.16, look.shirt), vbox(0, -0.4, 0, 0.14, 0.2, 0.15, look.skin)] },
      armR: { parent: "torso", at: [-0.29, BODY_H - 0.06, 0], boxes: [vbox(0, -0.2, 0, 0.15, 0.24, 0.16, look.shirt), vbox(0, -0.4, 0, 0.14, 0.2, 0.15, look.skin)] }
    };
    const props = {
      mug: { parent: "armR", boxes: [vbox(0, -0.56, 0.1, 0.1, 0.12, 0.1, "#fdfaf3"), vbox(0.065, -0.53, 0.1, 0.03, 0.06, 0.04, "#fdfaf3"), vbox(0, -0.45, 0.1, 0.08, 0.01, 0.08, "#6b4630")] },
      snack: { parent: "armL", boxes: [vbox(0, -0.54, 0.09, 0.12, 0.06, 0.1, "#e8b25a"), vbox(0, -0.49, 0.09, 0.1, 0.02, 0.08, "#f6e3b4")] },
      book: { parent: "armL", boxes: [vbox(-0.12, -0.5, 0.14, 0.26, 0.2, 0.03, "#c4523f"), vbox(-0.12, -0.5, 0.155, 0.24, 0.18, 0.01, "#fdf6e6")] },
      can: { parent: "armR", boxes: [vbox(0, -0.6, 0.12, 0.12, 0.14, 0.18, "#5fa7a0"), vbox(0, -0.52, 0.26, 0.04, 0.04, 0.16, "#5fa7a0"), vbox(0, -0.46, 0.12, 0.03, 0.06, 0.12, "#3f7f78")] },
      marker: { parent: "armR", boxes: [vbox(0, -0.58, 0.04, 0.03, 0.12, 0.03, "#2f6fd0")] }
    };
    return { look, parts, props };
  }

  // public/js/room.js
  var GARDEN_BORDER = 2.5;
  function gardenBoxes(grid) {
    const W = grid.w, D = grid.d;
    const deco = [];
    let seed = hashStr(`${W}x${D}`);
    const rnd = () => {
      seed = seed * 1664525 + 1013904223 >>> 0;
      return seed / 4294967296;
    };
    const tree = (x, z, s) => {
      deco.push(vbox(x, -0.01, z, 0.3 * s, 1.1 * s, 0.3 * s, "#8a5a3a"));
      deco.push(vbox(x, 0.9 * s, z, 1.2 * s, 0.8 * s, 1.2 * s, "#4f9c43"));
      deco.push(vbox(x + 0.1 * s, 1.55 * s, z - 0.05 * s, 0.8 * s, 0.5 * s, 0.8 * s, "#5fae4e"));
      deco.push(vbox(x - 0.25 * s, 1.2 * s, z + 0.3 * s, 0.5 * s, 0.4 * s, 0.5 * s, "#72c05a"));
    };
    const bush = (x, z) => {
      deco.push(vbox(x, -0.01, z, 0.7, 0.45, 0.6, "#5aa64a"));
      deco.push(vbox(x + 0.1, 0.35, z, 0.4, 0.25, 0.4, "#6cba57"));
    };
    const flower = (x, z, c) => {
      deco.push(vbox(x, -0.01, z, 0.04, 0.2, 0.04, "#3f8a3a"));
      deco.push(vbox(x, 0.19, z, 0.12, 0.1, 0.12, c));
    };
    const ring = [];
    for (let x = -1.6; x < W + 1.6; x += 1.4) {
      ring.push([x, -1.4], [x, D + 1.4]);
    }
    for (let z = 0; z < D; z += 1.4) {
      ring.push([-1.4, z], [W + 1.4, z]);
    }
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
  function wallBoxes(len, doorAt) {
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
  function roomWalls(grid) {
    const W = grid.w, D = grid.d;
    return [
      { name: "back", surface: "wallBack", len: W, doorAt: null, at: [0, 0, 0], yaw: 0 },
      { name: "front", surface: "wallPlain", len: W, doorAt: W / 2, at: [W, 0, D], yaw: Math.PI },
      { name: "left", surface: "wallLeft", len: D, doorAt: null, at: [0, 0, D], yaw: Math.PI / 2 },
      { name: "right", surface: "wallPlain", len: D, doorAt: null, at: [W, 0, 0], yaw: -Math.PI / 2 }
    ];
  }
  function cornerPosts(grid) {
    const W = grid.w, D = grid.d;
    return [[0, 0], [W, 0], [0, D], [W, D]].map(([x, z]) => vbox(x, 0, z, 0.3, WALL_H + 0.12, 0.3, "#ffffff"));
  }

  // public/js/textures.js
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
  }
  function canvas(w, h) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return [c, c.getContext("2d")];
  }
  function tex(c, { repeat = false, srgb = true } = {}) {
    const t = new CanvasTexture(c);
    t.magFilter = NearestFilter;
    t.minFilter = NearestMipmapLinearFilter;
    t.generateMipmaps = true;
    if (srgb) t.colorSpace = SRGBColorSpace;
    if (repeat) {
      t.wrapS = t.wrapT = RepeatWrapping;
    }
    t.anisotropy = 4;
    return t;
  }
  var shade = (hex, f) => {
    const c = new Color(hex);
    c.multiplyScalar(f);
    return `#${c.getHexString()}`;
  };
  function grainTexture() {
    const [c, g] = canvas(16, 16);
    const r = rng(7);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const v = Math.round(255 * (0.88 + r() * 0.12));
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x, y, 1, 1);
    }
    return tex(c, { repeat: true });
  }
  function grassTexture() {
    const [c, g] = canvas(16, 16);
    const r = rng(31);
    const greens = ["#79b85a", "#6fae52", "#86c265", "#68a44c", "#8ccb6b"];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      g.fillStyle = greens[Math.floor(r() * greens.length)];
      g.fillRect(x, y, 1, 1);
    }
    return tex(c, { repeat: true });
  }
  function plinthTexture() {
    const [c, g] = canvas(16, 16);
    const r = rng(37);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const course = y >> 2;
      const joint = y % 4 === 3 || (x + course % 2 * 4) % 8 === 7;
      const cap = y < 2;
      const base = cap ? "#b9a892" : course % 2 ? "#d8c6a8" : "#cfbb9b";
      g.fillStyle = joint ? shade("#9c8a72", 0.95 + r() * 0.08) : shade(base, 0.93 + r() * 0.1);
      g.fillRect(x, y, 1, 1);
    }
    return tex(c, { repeat: true });
  }
  function rugTexture() {
    const [c, g] = canvas(32, 48);
    const r = rng(41);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 32; x++) {
      const border = x < 2 || y < 2 || x > 29 || y > 45;
      const inner = x === 3 || y === 3 || x === 28 || y === 44;
      const check = ((x >> 2) + (y >> 2)) % 2 === 0;
      const v = border ? 0.62 : inner ? 1 : check ? 0.9 : 0.84;
      const n = v * (0.95 + r() * 0.06);
      const k2 = Math.round(255 * Math.min(1, n));
      g.fillStyle = `rgb(${k2},${k2},${k2})`;
      g.fillRect(x, y, 1, 1);
    }
    return tex(c);
  }
  function screenTexture() {
    const [c, g] = canvas(32, 20);
    const r = rng(53);
    g.fillStyle = "#18233a";
    g.fillRect(0, 0, 32, 20);
    const cols = ["#7fd1ff", "#ffd479", "#b8f28a", "#ff9fb8", "#c9b6ff", "#e8eef8"];
    for (let y = 2; y < 18; y += 2) {
      let x = 2 + (r() < 0.5 ? 2 : 0) + (r() < 0.3 ? 2 : 0);
      while (x < 29) {
        const len = 2 + Math.floor(r() * 6);
        g.fillStyle = cols[Math.floor(r() * cols.length)];
        g.fillRect(x, y, Math.min(len, 30 - x), 1);
        x += len + 1;
        if (r() < 0.25) break;
      }
    }
    g.fillStyle = "#2b3a5c";
    g.fillRect(0, 0, 32, 1);
    return tex(c);
  }
  function tvTexture() {
    const [c, g] = canvas(32, 18);
    g.fillStyle = "#1d2440";
    g.fillRect(0, 0, 32, 18);
    const bars = [5, 9, 7, 12, 10, 14, 11];
    bars.forEach((h, i) => {
      g.fillStyle = i % 2 ? "#ffb86b" : "#7ee0c3";
      g.fillRect(3 + i * 3, 16 - h, 2, h);
    });
    g.fillStyle = "#ff7a9c";
    g.fillRect(25, 3, 5, 5);
    g.fillStyle = "#ffe08a";
    g.fillRect(25, 10, 5, 2);
    g.fillRect(25, 13, 3, 2);
    return tex(c);
  }
  function rackTexture() {
    const [c, g] = canvas(16, 32);
    const r = rng(61);
    g.fillStyle = "#20232b";
    g.fillRect(0, 0, 16, 32);
    for (let y = 1; y < 31; y += 3) {
      g.fillStyle = "#2e323d";
      g.fillRect(1, y, 14, 2);
      g.fillStyle = r() < 0.5 ? "#6dffb0" : r() < 0.5 ? "#7fc8ff" : "#ffcf6b";
      g.fillRect(2, y, 1, 1);
      if (r() < 0.6) {
        g.fillStyle = "#6dffb0";
        g.fillRect(4, y, 1, 1);
      }
    }
    return tex(c);
  }
  function windowTexture(night) {
    const [c, g] = canvas(32, 16);
    const r = rng(night ? 71 : 73);
    const grad = g.createLinearGradient(0, 0, 0, 16);
    if (night) {
      grad.addColorStop(0, "#141a3a");
      grad.addColorStop(1, "#2b2f5e");
    } else {
      grad.addColorStop(0, "#8fd0ff");
      grad.addColorStop(1, "#d8f0ff");
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 16);
    if (night) {
      for (let i = 0; i < 14; i++) {
        g.fillStyle = r() < 0.3 ? "#fff6c8" : "#cfd8ff";
        g.fillRect(Math.floor(r() * 32), Math.floor(r() * 11), 1, 1);
      }
      g.fillStyle = "#fff3c4";
      g.fillRect(24, 3, 3, 3);
      g.fillStyle = "#2b2f5e";
      g.fillRect(25, 3, 2, 1);
      g.fillStyle = "#3a3f73";
      g.fillRect(0, 13, 32, 3);
      g.fillStyle = "#ffd27a";
      for (let x = 1; x < 32; x += 4) if (r() < 0.6) g.fillRect(x, 14, 1, 1);
    } else {
      g.fillStyle = "#ffffff";
      g.fillRect(4, 4, 6, 2);
      g.fillRect(6, 3, 3, 1);
      g.fillRect(18, 7, 8, 2);
      g.fillRect(20, 6, 4, 1);
      g.fillStyle = "#86c46a";
      g.fillRect(0, 13, 32, 3);
      g.fillStyle = "#6aa955";
      for (let x = 0; x < 32; x += 3) g.fillRect(x, 12 + x % 2, 2, 1);
    }
    return tex(c);
  }
  function grey(g, x, y, v) {
    const k2 = Math.round(255 * Math.max(0, Math.min(1, v)));
    g.fillStyle = `rgb(${k2},${k2},${k2})`;
    g.fillRect(x, y, 1, 1);
  }
  function floorTexture(material) {
    const [c, g] = canvas(16, 16);
    const r = rng({ wood: 11, tile: 13, concrete: 17, carpet: 19 }[material] ?? 23);
    if (material === "wood") {
      const tone = [0.98, 0.9, 1.02, 0.93];
      for (let p = 0; p < 4; p++) {
        for (let y = p * 4; y < p * 4 + 4; y++) for (let x = 0; x < 16; x++) grey(g, x, y, tone[p] * (0.95 + r() * 0.06) - (y === p * 4 + 3 ? 0.1 : 0));
        const seam = (p * 7 + 3) % 16;
        for (let y = p * 4; y < p * 4 + 4; y++) grey(g, seam, y, tone[p] * 0.7);
        if (r() < 0.6) {
          const x = Math.floor(r() * 14);
          grey(g, x, p * 4 + 1, tone[p] * 0.8);
          grey(g, x + 1, p * 4 + 1, tone[p] * 0.8);
        }
      }
    } else if (material === "tile") {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const grout = x % 8 === 7 || y % 8 === 7;
        const which = ((x >> 3) + (y >> 3)) % 2;
        const edge = x % 8 === 0 || y % 8 === 0;
        grey(g, x, y, grout ? 0.66 : (which ? 0.97 : 0.92) * (edge ? 1.04 : 1) * (0.98 + r() * 0.03));
      }
    } else if (material === "concrete") {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        let v = 0.95 + r() * 0.05;
        if (r() < 0.05) v -= 0.12;
        if (r() < 0.03) v += 0.08;
        grey(g, x, y, v);
      }
      for (let x = 0; x < 16; x++) grey(g, x, 15, 0.8);
    } else if (material === "carpet") {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const loop = (x + y) % 4 === 0 ? 0.04 : 0;
        grey(g, x, y, 0.91 + r() * 0.06 + loop);
      }
    } else throw new Error(`floorTexture: unknown material ${JSON.stringify(material)}`);
    return tex(c, { repeat: true });
  }
  function wallTexture(material) {
    const [c, g] = canvas(16, 16);
    const r = rng({ plaster: 29, brick: 31, "wood-panels": 37 }[material] ?? 41);
    if (material === "plaster") {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) grey(g, x, y, 0.93 + r() * 0.07);
    } else if (material === "brick") {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const course = y >> 2;
        const mortar = y % 4 === 3 || (x + course % 2 * 4) % 8 === 7;
        const brickId = course * 2 + (x + course % 2 * 4 >> 3 & 1);
        const tone = 0.78 + brickId * 37 % 11 / 60;
        grey(g, x, y, mortar ? 1.12 + r() * 0.04 : tone * (0.94 + r() * 0.08));
      }
    } else if (material === "wood-panels") {
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const panel = x >> 2;
        const groove = x % 4 === 3;
        grey(g, x, y, groove ? 0.62 : [0.95, 0.88, 0.99, 0.91][panel] * (0.96 + r() * 0.06));
      }
    } else throw new Error(`wallTexture: unknown material ${JSON.stringify(material)}`);
    return tex(c, { repeat: true });
  }

  // tvos/bridge/pixel-canvas.js
  function parse(style) {
    let m = /^#([0-9a-f]{6})$/i.exec(style);
    if (m) {
      const n = parseInt(m[1], 16);
      return [n >> 16, n >> 8 & 255, n & 255];
    }
    m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(style);
    if (m) return [+m[1], +m[2], +m[3]];
    throw new Error(`pixel-canvas: unsupported fillStyle ${JSON.stringify(style)}`);
  }
  function verticalGradient(y0, y1) {
    const stops = [];
    return {
      addColorStop(at, color2) {
        stops.push([at, parse(color2)]);
        stops.sort((a, b) => a[0] - b[0]);
      },
      at(y) {
        const t = Math.max(0, Math.min(1, (y + 0.5 - y0) / (y1 - y0)));
        if (t <= stops[0][0]) return stops[0][1];
        for (let i = 1; i < stops.length; i++) {
          const [b, cb] = stops[i], [a, ca] = stops[i - 1];
          if (t <= b) {
            const k2 = (t - a) / (b - a);
            return ca.map((v, c) => Math.round(v + (cb[c] - v) * k2));
          }
        }
        return stops[stops.length - 1][1];
      }
    };
  }
  function pixelCanvas(w, h) {
    const px = new Uint8Array(w * h * 3);
    let fill = [0, 0, 0];
    const ctx = {
      set fillStyle(s) {
        fill = typeof s === "string" ? parse(s) : s;
      },
      get fillStyle() {
        return fill;
      },
      createLinearGradient(x0, y0, x1, y1) {
        if (x0 !== x1) throw new Error("pixel-canvas: only vertical gradients are supported");
        return verticalGradient(y0, y1);
      },
      fillRect(x, y, rw, rh) {
        for (let j = Math.max(0, y); j < Math.min(h, y + rh); j++) {
          const c = Array.isArray(fill) ? fill : fill.at(j);
          for (let i = Math.max(0, x); i < Math.min(w, x + rw); i++) px.set(c, (j * w + i) * 3);
        }
      }
    };
    return {
      width: w,
      height: h,
      pixels: px,
      getContext(kind) {
        if (kind !== "2d") throw new Error(`pixel-canvas: no ${kind} context`);
        return ctx;
      }
    };
  }
  function installDocument() {
    globalThis.document = {
      createElement(tag) {
        if (tag !== "canvas") throw new Error(`pixel-canvas: document.createElement(${tag}) is not available`);
        const c = { _w: 0, _h: 0, _real: null };
        return new Proxy(c, {
          set(t, k2, v) {
            if (k2 === "width") t._w = v;
            else if (k2 === "height") t._h = v;
            else t[k2] = v;
            return true;
          },
          get(t, k2) {
            if (k2 === "getContext") return (kind) => {
              t._real ?? (t._real = pixelCanvas(t._w, t._h));
              return t._real.getContext(kind);
            };
            if (k2 === "width") return t._w;
            if (k2 === "height") return t._h;
            if (k2 === "pixels") return t._real?.pixels;
            return t[k2];
          }
        });
      }
    };
  }

  // tvos/bridge/entry.js
  installDocument();
  var TEXTURES = {
    grain: () => grainTexture(),
    grass: () => grassTexture(),
    plinth: () => plinthTexture(),
    rug: () => rugTexture(),
    floor: (m) => floorTexture(m),
    wall: (m) => wallTexture(m),
    screen: () => screenTexture(),
    tv: () => tvTexture(),
    rack: () => rackTexture(),
    window: () => windowTexture(false)
  };
  var state = null;
  var walk = null;
  var boxesOf = (list2) => (list2 ?? []).map((b) => ({ at: b.at, size: b.size, color: b.color, faces: b.faces ?? null, unitUV: !!b.unitUV }));
  function kindParts(kind, custom) {
    if (MODELS[kind]) {
      const m = MODELS[kind]();
      return {
        defaultColor: m.defaultColor ?? null,
        glowColor: m.glow?.color ?? null,
        parts: [
          { role: "base", boxes: boxesOf(m.base) },
          { role: "accent", boxes: boxesOf(m.accent), map: m.accentMap === "rug" ? "rug" : "grain" },
          { role: "finish", boxes: boxesOf(m.finish) },
          { role: "rail", boxes: boxesOf(m.rail) },
          { role: "glow", boxes: boxesOf(m.glow?.boxes), map: m.glow?.tex ?? null }
        ].filter((p) => p.boxes.length)
      };
    }
    const def = custom[kind];
    if (!def) throw new Error(`no model for kind "${kind}"`);
    const plan = kindGeometryPlan(def);
    const toBox = (b, unitUV = false) => ({ at: [b.cx, b.y0, b.cz], size: [b.w, b.h, b.d], color: b.color, faces: null, unitUV });
    return {
      defaultColor: null,
      glowColor: null,
      parts: [
        { role: "base", boxes: [...plan.matte, ...plan.glossy].map((b) => toBox(b)) },
        { role: "glass", boxes: plan.glass.map((b) => toBox(b)) },
        { role: "glow", boxes: plan.screen.map((b) => toBox(b, true)), map: "screen" },
        { role: "glow", boxes: plan.emissive.map((b) => toBox(b)), map: null }
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
      const g = buildGeometry(JSON.parse(json).map((b) => ({ ...b, faces: b.faces ?? void 0 })), { ao, floorY });
      const a = g.attributes;
      const r = (arr) => arr.map((v) => Math.round(v * 1e5) / 1e5);
      return JSON.stringify({ pos: r(a.position.array), nor: a.normal.array, col: r(a.color.array), uv: r(a.uv.array), idx: g.index });
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
        posts: cornerPosts(grid)
      });
    },
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
      walk = { blocked: blockedCells(state.items, state.grid, custom), grid: state.grid };
      return JSON.stringify({
        id: state.id,
        name: state.name ?? null,
        grid: state.grid,
        wallH: WALL_H,
        theme: state.theme,
        look: themeLook(state.theme),
        kinds,
        items,
        agents: state.agents.map((a) => ({
          id: a.id,
          name: a.name,
          emoji: a.emoji ?? null,
          status: a.status,
          activity: a.activity ?? null,
          hue: a.hue,
          css: hueColors(a.hue ?? 0).css,
          phase: hashStr(a.id) % 1e3 / 100,
          says: a.says && now - a.says.ts < 9e3 ? a.says.text : null,
          rig: characterRig(a),
          target: t.get(a.id)
        })),
        chat: state.chat.slice(-6).map((m) => ({ from: nameOf(m.from), to: m.to ? nameOf(m.to) : null, text: m.text, ts: m.ts }))
      });
    }
  };
})();
