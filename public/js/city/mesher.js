// Greedy heightfield mesher for the voxel city (format v2). Pure: runs in the module worker and in node checks.
// Imports only ../../shared/city.js by relative path (module workers get no importmap; no three here).
//
// Each column is a stack of solid y-intervals: terrain [0, ground], building wall [base, top[k]] (the v2
// per-column top, so tapers, bowls and sawtooth faces come out of the same mesher), deck pillar
// [top, deckY − 1] (negative deck) and deck slab [deckY − 1, deckY]. Top faces are merged greedily by
// (y, colour, corner AO); side faces are the parts of a column's segments not covered by the neighbour
// column, merged into one quad per run of equal (lo, hi, colour) along the boundary. An absent neighbour is
// water (covers nothing above y = 0); an unbuilt neighbour (landmask land) covers up to its coarse height
// and the exposed terrain above it is drawn as a paper-tone skirt.
//
// Building styling (spec-v2 §4): walls with facade 0 go to `walls` (window atlas); every other facade goes
// to `opaque` with a pattern (ribs, parking bands, ground-floor arcade, curtain mullions). Side faces at
// y ≥ accentFrom use the accent colour. The column's top face is coloured by cap (flat roof, crown,
// spire metal, dome, green roof, seat rows). Natural terrain tops get hypsometric shading with a contour
// every HILL_CONTOUR blocks so 1:1 hills still read.
//
// MeshBuffers = {
//   positions: Float32Array  xyz, local to `origin` (chunk or region corner, y = 0)
//   normals:   Int8Array     xyz, normalised (±127)
//   colors:    Uint8Array    rgb, normalised, LINEAR (already sRGB-decoded, AO baked in):
//                            new THREE.BufferAttribute(colors, 3, true) + vertexColors
//   uvs?:      Float32Array  LOD0 opaque/walls only, in blocks (1 uv unit = 1 block). Opaque: top faces (x, z),
//                            sides (along, y), for grainTexture(). Walls: (along, y) for the window atlas,
//                            whose textures carry repeat 1/8 (see textures.js).
//   glow?:     Uint8Array    one per vertex. Regions: 255 on window walls (night window grid in scene.js).
//                            Props: 255 on emissive props (light towers).
//   indices:   Uint32Array   triangles, counter-clockwise from outside
//   origin:    [x, y, z]     world block coordinates of local (0, 0, 0)
// }

import {
  BUILDING_PALETTE, CAP, CHUNK, COLUMNS, DECK_COLORS, FACADE, LANDMASK_CELL, PALETTE_INDEX, REGION, ROOF_DARKEN, SURFACE,
  SURFACE_COLORS, TERRAIN_SIDE_COLORS, UNBUILT_COLORS, chunkKey, regionOf,
} from "../../shared/city.js";

// ---------- colours (linear RGB, indexed by a colour id) ----------

const C_SIDE = 32;
const C_DECK_TOP = 64;
const C_DECK_EDGE = 65;
const C_PILLAR = 66;
const C_DECK_UNDER = 67;
const C_UNBUILT_TOP = 68;
const C_UNBUILT_SIDE = 69;
const C_GREEN_ROOF = 70;
const C_PAL = 128;
const PAL_STRIDE = 64;
/** Palette colour variants: wall, wall pattern (ribs, openings), roof, light (crown), roof pattern (seat rows). */
const V_WALL = 0, V_DARK = 1, V_ROOF = 2, V_LIGHT = 3, V_ROOF_DARK = 4;
const VARIANT_FACTOR = [1, 0.78, 1 - ROOF_DARKEN, 1.14, 0.8];
const N_COLORS = C_PAL + PAL_STRIDE * VARIANT_FACTOR.length;
const GREEN_ROOF_HEX = SURFACE_COLORS[SURFACE.PARK];
const METAL = PALETTE_INDEX.metal;

if (BUILDING_PALETTE.length > PAL_STRIDE) throw new Error(`mesher: palette has ${BUILDING_PALETTE.length} colours, the colour table holds ${PAL_STRIDE}`);
if (Math.max(...Object.values(SURFACE)) >= C_SIDE) throw new Error("mesher: surface ids overflow the colour table");
if (METAL === undefined) throw new Error("mesher: palette has no 'metal' colour for spire caps");

/** Colour id of palette index p in variant v. */
const pal = (v, p) => C_PAL + v * PAL_STRIDE + p;
const isPal = (id) => id >= C_PAL;
const darkOf = (id) => (isPal(id) ? C_PAL + V_DARK * PAL_STRIDE + ((id - C_PAL) % PAL_STRIDE) : id);

export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function hexRgb(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`mesher: bad colour ${hex}`);
  return [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);
}
/** Linear colour bytes the mesher writes for `hex` at brightness `factor` (checks compare against this). */
export function linearBytes(hex, factor = 1) {
  return hexRgb(hex).map((c) => Math.round(srgbToLinear(Math.min(1, c * factor)) * 255));
}

const LINEAR = new Float32Array(N_COLORS * 3).fill(NaN);
function defineColor(id, hex, factor = 1) {
  hexRgb(hex).forEach((c, k) => { LINEAR[id * 3 + k] = srgbToLinear(Math.min(1, c * factor)); });
}
for (const [s, hex] of Object.entries(SURFACE_COLORS)) defineColor(Number(s), hex);
for (const [s, hex] of Object.entries(TERRAIN_SIDE_COLORS)) defineColor(C_SIDE + Number(s), hex);
BUILDING_PALETTE.forEach((hex, p) => VARIANT_FACTOR.forEach((f, v) => defineColor(pal(v, p), hex, f)));
defineColor(C_DECK_TOP, DECK_COLORS.top);
defineColor(C_DECK_EDGE, DECK_COLORS.edge);
defineColor(C_PILLAR, DECK_COLORS.pillar);
defineColor(C_DECK_UNDER, DECK_COLORS.under);
defineColor(C_UNBUILT_TOP, UNBUILT_COLORS.top);
defineColor(C_UNBUILT_SIDE, UNBUILT_COLORS.side);
defineColor(C_GREEN_ROOF, GREEN_ROOF_HEX);

/** Top-vertex brightness by occluder count (0–3), Minecraft-style. */
const AO_LEVELS = [1, 0.8, 0.66, 0.54];
/** Brightness of a side face's bottom edge where it meets the neighbour's top. */
const SIDE_CONTACT = 0.72;

// ---------- hill shading ----------

/** Natural ground darkens on every HILL_CONTOUR-th terrace, so slopes read as contour bands. */
export const HILL_CONTOUR = 10;
const CONTOUR_SHADE = 0.88;
/** Hypsometric tint: ground at y = 0 is HILL_LOW bright, ground at HILL_SPAN and above is HILL_HIGH. */
const HILL_LOW = 0.94, HILL_HIGH = 1.12, HILL_SPAN = 90;
const NATURAL = new Set([SURFACE.SAND, SURFACE.GRASS, SURFACE.PARK, SURFACE.FOREST, SURFACE.HILL, SURFACE.DIRT, C_UNBUILT_TOP]);

/** Pure. Brightness factor of a terrain top face with colour id `colorId` at height y (1 for non-terrain). */
export function hillShade(colorId, y) {
  if (colorId >= C_SIDE && colorId !== C_UNBUILT_TOP) return 1;
  const t = Math.min(1, Math.max(0, y / HILL_SPAN));
  const f = HILL_LOW + (HILL_HIGH - HILL_LOW) * t;
  return NATURAL.has(colorId) && y > 0 && y % HILL_CONTOUR === 0 ? f * CONTOUR_SHADE : f;
}

// ---------- geometry builder ----------

function createBuilder({ uvs = false, glow = false } = {}) {
  let cap = 1024;
  let nv = 0;
  let ni = 0;
  let pos = new Float32Array(cap * 3);
  let nor = new Int8Array(cap * 3);
  let col = new Uint8Array(cap * 3);
  let uv = uvs ? new Float32Array(cap * 2) : null;
  let gl = glow ? new Uint8Array(cap) : null;
  let idx = new Uint32Array(cap * 1.5);
  const grow = () => {
    cap *= 2;
    const g = (a, n) => { const b = new a.constructor(cap * n); b.set(a); return b; };
    pos = g(pos, 3); nor = g(nor, 3); col = g(col, 3);
    if (uv) uv = g(uv, 2);
    if (gl) gl = g(gl, 1);
    idx = g(idx, 1.5);
  };
  return {
    /**
     * corners: 12 numbers, 4 xyz corners counter-clockwise from the front. normal: [nx, ny, nz].
     * shade: 4 brightness factors. uvq: 8 numbers or null. flip: split along corners 1–3 instead of 0–2.
     */
    quad(corners, normal, colorId, shade, uvq, flip, glowOn) {
      if (nv + 4 > cap) grow();
      const r = LINEAR[colorId * 3], g = LINEAR[colorId * 3 + 1], b = LINEAR[colorId * 3 + 2];
      if (Number.isNaN(r)) throw new Error(`mesher: undefined colour id ${colorId}`);
      for (let k = 0; k < 4; k++) {
        const v = nv + k;
        pos[v * 3] = corners[k * 3]; pos[v * 3 + 1] = corners[k * 3 + 1]; pos[v * 3 + 2] = corners[k * 3 + 2];
        nor[v * 3] = normal[0] * 127; nor[v * 3 + 1] = normal[1] * 127; nor[v * 3 + 2] = normal[2] * 127;
        const f = shade[k];
        col[v * 3] = Math.round(Math.min(1, r * f) * 255); col[v * 3 + 1] = Math.round(Math.min(1, g * f) * 255); col[v * 3 + 2] = Math.round(Math.min(1, b * f) * 255);
        if (uv) { uv[v * 2] = uvq ? uvq[k * 2] : 0; uv[v * 2 + 1] = uvq ? uvq[k * 2 + 1] : 0; }
        if (gl) gl[v] = glowOn ? 255 : 0;
      }
      if (flip) { idx[ni++] = nv + 1; idx[ni++] = nv + 2; idx[ni++] = nv + 3; idx[ni++] = nv + 1; idx[ni++] = nv + 3; idx[ni++] = nv; }
      else { idx[ni++] = nv; idx[ni++] = nv + 1; idx[ni++] = nv + 2; idx[ni++] = nv; idx[ni++] = nv + 2; idx[ni++] = nv + 3; }
      nv += 4;
    },
    finish(origin) {
      const out = {
        positions: pos.slice(0, nv * 3),
        normals: nor.slice(0, nv * 3),
        colors: col.slice(0, nv * 3),
        indices: idx.slice(0, ni),
        origin,
      };
      if (uv) out.uvs = uv.slice(0, nv * 2);
      if (gl) out.glow = gl.slice(0, nv);
      return out;
    },
  };
}

// ---------- the cell grid ----------
// A grid is w×w cells plus a one-cell border holding neighbour coverage. A cell is one column (LOD0), an f×f
// downsample (LOD1/2) or a landmask cell (unbuilt land). Coverage = solid [0, u1] ∪ [u2lo, u2hi] (u2hi = 0: none).
// Segment kind: 0 terrain / deck, 1 + facade for a building wall (1 = window atlas).

const MAX_SEGS = 4;
const K_TERRAIN = 0;
const K_ATLAS = 1 + FACADE.WINDOWS;
const kindOf = (facade) => 1 + facade;
const glows = (kind) => kind === K_ATLAS || kind === kindOf(FACADE.CURTAIN);

function createGrid(w) {
  const p = w + 2;
  const n = p * p;
  return {
    w, p,
    exists: new Uint8Array(n),
    unknown: new Uint8Array(n),
    paper: new Uint8Array(n),
    segN: new Uint8Array(n),
    segLo: new Int16Array(n * MAX_SEGS),
    segHi: new Int16Array(n * MAX_SEGS),
    segC: new Uint16Array(n * MAX_SEGS),
    segKind: new Uint8Array(n * MAX_SEGS),
    segAccFrom: new Int16Array(n * MAX_SEGS),
    segAccC: new Uint16Array(n * MAX_SEGS),
    u1: new Int16Array(n),
    u2lo: new Int16Array(n),
    u2hi: new Int16Array(n),
    topC: new Uint16Array(n),
    gMin: new Int16Array(n),
  };
}
const cellAt = (grid, i, j) => (j + 1) * grid.p + (i + 1);

const NO_ACCENT = 0x7fff;

/**
 * Fill cell c. gEff: terrain top (a building's base). bodyTop: the column's building top or gEff. B: the building
 * entry or null. sideC: terrain-side colour id. topC: top-face colour id. deck: signed chunk deck value.
 */
function setCell(grid, c, gEff, bodyTop, B, sideC, topC, deck) {
  const o = c * MAX_SEGS;
  let n = 0;
  const seg = (lo, hi, colorId, kind, accFrom = NO_ACCENT, accC = 0) => {
    grid.segLo[o + n] = lo; grid.segHi[o + n] = hi; grid.segC[o + n] = colorId; grid.segKind[o + n] = kind;
    grid.segAccFrom[o + n] = accFrom; grid.segAccC[o + n] = accC;
    n++;
  };
  if (gEff > 0) seg(0, gEff, sideC, K_TERRAIN);
  if (B && bodyTop > gEff) seg(gEff, bodyTop, pal(V_WALL, B.palette), kindOf(B.facade), B.accentFrom, pal(V_WALL, B.accent));
  let u1 = bodyTop, u2lo = 0, u2hi = 0, top = topC;
  const d = deck < 0 ? -deck : deck;
  if (deck !== 0 && d > bodyTop) {
    const slabLo = Math.max(d - 1, bodyTop);
    if (deck > 0 && slabLo > bodyTop) {
      u2lo = slabLo;
      u2hi = d;
    } else {
      if (slabLo > bodyTop) seg(bodyTop, slabLo, C_PILLAR, K_TERRAIN);
      u1 = d;
      top = C_DECK_TOP;
    }
    seg(slabLo, d, C_DECK_EDGE, K_TERRAIN);
  }
  grid.segN[c] = n;
  grid.u1[c] = u1;
  grid.u2lo[c] = u2lo;
  grid.u2hi[c] = u2hi;
  grid.topC[c] = top;
}

/** Pure. Colour id of a building column's top face at height `top`, by the entry's cap. */
export function capColorId(B, top) {
  switch (B.cap) {
    case CAP.FLAT: return pal(V_ROOF, B.palette);
    case CAP.CROWN: return pal(V_LIGHT, B.accent);
    case CAP.SPIRE: return pal(V_WALL, METAL);
    case CAP.DOME: return pal(V_WALL, B.accent);
    case CAP.GREEN: return C_GREEN_ROOF;
    case CAP.SEATS: return pal(top % 2 ? V_ROOF_DARK : V_ROOF, B.accent);
    default: throw new Error(`mesher: unknown cap ${B.cap}`);
  }
}

function entryOf(chunk, k) {
  const B = chunk.buildings[chunk.bldg[k] - 1];
  if (!B) throw new Error(`mesher: chunk ${chunk.cx},${chunk.cz} column ${k} points past its building table`);
  return B;
}

/** Column k of a chunk into grid cell c. */
function setColumn(grid, c, chunk, k) {
  const g = chunk.ground[k];
  const s = chunk.surface[k];
  if (chunk.bldg[k]) {
    const B = entryOf(chunk, k);
    const top = chunk.top[k];
    setCell(grid, c, g, top, B, C_SIDE + s, capColorId(B, top), chunk.deck[k]);
  } else {
    setCell(grid, c, g, g, null, C_SIDE + s, s, chunk.deck[k]);
  }
  grid.gMin[c] = g;
}

/** Border cell c holds unbuilt land of coarse height h (0 = sea: left absent). */
function setUnbuilt(grid, c, h) {
  if (h <= 0) return;
  setCell(grid, c, h, h, null, C_UNBUILT_SIDE, C_UNBUILT_TOP, 0);
  grid.gMin[c] = h;
  grid.paper[c] = 1;
}

// ---------- meshing a grid ----------

function occludes(grid, n, y) {
  return grid.u1[n] >= y + 1 || (grid.u2hi[n] >= y + 1 && grid.u2lo[n] <= y);
}

/** Corner AO for a top face at y on cell (i, j), packed 2 bits per corner: (−,−), (−,+), (+,+), (+,−). */
function topAo(grid, i, j, y) {
  let packed = 0;
  const corners = [[-1, -1], [-1, 1], [1, 1], [1, -1]];
  for (let k = 0; k < 4; k++) {
    const [dx, dz] = corners[k];
    const s1 = occludes(grid, cellAt(grid, i + dx, j), y) ? 1 : 0;
    const s2 = occludes(grid, cellAt(grid, i, j + dz), y) ? 1 : 0;
    const cr = occludes(grid, cellAt(grid, i + dx, j + dz), y) ? 1 : 0;
    packed |= (s1 && s2 ? 3 : s1 + s2 + cr) << (k * 2);
  }
  return packed;
}

/** Greedy rectangles over a w×w layer: cells with has=1 merge when ky and kc both match. */
function greedy(w, has, ky, kc, emit) {
  const used = new Uint8Array(w * w);
  for (let j = 0; j < w; j++) {
    for (let i = 0; i < w; i++) {
      const a = j * w + i;
      if (!has[a] || used[a]) continue;
      const y = ky[a], c = kc[a];
      const same = (b) => has[b] && !used[b] && ky[b] === y && kc[b] === c;
      let i1 = i + 1;
      while (i1 < w && same(j * w + i1)) i1++;
      let j1 = j + 1;
      grow: while (j1 < w) {
        for (let x = i; x < i1; x++) if (!same(j1 * w + x)) break grow;
        j1++;
      }
      for (let z = j; z < j1; z++) for (let x = i; x < i1; x++) used[z * w + x] = 1;
      emit(i, j, i1, j1, y, c);
    }
  }
}

const UP = [0, 1, 0];
const DOWN = [0, -1, 0];
const FLAT = [1, 1, 1, 1];

function meshTops(grid, scale, { ao, uvs }, opaque) {
  const { w } = grid;
  const n = w * w;
  const layers = [
    { has: new Uint8Array(n), ky: new Int32Array(n), kc: new Int32Array(n), down: false },
    { has: new Uint8Array(n), ky: new Int32Array(n), kc: new Int32Array(n), down: false },
    { has: new Uint8Array(n), ky: new Int32Array(n), kc: new Int32Array(n), down: true },
  ];
  for (let j = 0; j < w; j++) {
    for (let i = 0; i < w; i++) {
      const c = cellAt(grid, i, j);
      if (!grid.exists[c]) continue;
      const a = j * w + i;
      const y = grid.u1[c];
      layers[0].has[a] = 1; layers[0].ky[a] = y;
      layers[0].kc[a] = (grid.topC[c] << 8) | (ao ? topAo(grid, i, j, y) : 0);
      if (grid.u2hi[c]) {
        const ys = grid.u2hi[c];
        layers[1].has[a] = 1; layers[1].ky[a] = ys;
        layers[1].kc[a] = (C_DECK_TOP << 8) | (ao ? topAo(grid, i, j, ys) : 0);
        layers[2].has[a] = 1; layers[2].ky[a] = grid.u2lo[c]; layers[2].kc[a] = C_DECK_UNDER << 8;
      }
    }
  }
  for (const L of layers) {
    greedy(w, L.has, L.ky, L.kc, (i0, j0, i1, j1, y, key) => {
      const x0 = i0 * scale, x1 = i1 * scale, z0 = j0 * scale, z1 = j1 * scale;
      const colorId = key >> 8;
      if (L.down) {
        opaque.quad([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1], DOWN, colorId, FLAT,
          uvs ? [x0, z0, x1, z0, x1, z1, x0, z1] : null, false, false);
        return;
      }
      const occ = [key & 3, (key >> 2) & 3, (key >> 4) & 3, (key >> 6) & 3];
      const hill = hillShade(colorId, y);
      const shade = occ.map((o) => AO_LEVELS[o] * hill);
      const flip = occ[0] + occ[2] < occ[1] + occ[3];
      opaque.quad([x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0], UP, colorId, shade,
        uvs ? [x0, z0, x0, z1, x1, z1, x1, z0] : null, flip, false);
    });
  }
}

// side directions: neighbour offset, and how (line, pos) map to (i, j)
const SIDES = [
  { di: 1, dj: 0, normal: [1, 0, 0], alongZ: true },
  { di: -1, dj: 0, normal: [-1, 0, 0], alongZ: true },
  { di: 0, dj: 1, normal: [0, 0, 1], alongZ: false },
  { di: 0, dj: -1, normal: [0, 0, -1], alongZ: false },
];

function sideQuad(dir, line, p0, p1, lo, hi, scale, uvs) {
  const { di, dj } = dir;
  if (dir.alongZ) {
    const X = (di > 0 ? line + 1 : line) * scale;
    const zA = p0 * scale, zB = p1 * scale;
    if (di > 0) {
      return {
        corners: [X, lo, zB, X, lo, zA, X, hi, zA, X, hi, zB],
        uv: uvs ? [-zB, lo, -zA, lo, -zA, hi, -zB, hi] : null,
      };
    }
    return {
      corners: [X, lo, zA, X, lo, zB, X, hi, zB, X, hi, zA],
      uv: uvs ? [zA, lo, zB, lo, zB, hi, zA, hi] : null,
    };
  }
  const Z = (dj > 0 ? line + 1 : line) * scale;
  const xA = p0 * scale, xB = p1 * scale;
  if (dj > 0) {
    return {
      corners: [xA, lo, Z, xB, lo, Z, xB, hi, Z, xA, hi, Z],
      uv: uvs ? [xA, lo, xB, lo, xB, hi, xA, hi] : null,
    };
  }
  return {
    corners: [xB, lo, Z, xA, lo, Z, xA, hi, Z, xB, hi, Z],
    uv: uvs ? [-xB, lo, -xA, lo, -xA, hi, -xB, hi] : null,
  };
}

const runKey = (lo, hi, colorId, kind, dark) => ((((lo + 1024) * 4096 + (hi + 1024)) * 1024 + colorId) * 8 + kind) * 2 + dark;

/** Facade pattern bands. Parking: an open deck every PARKING_FLOOR blocks. Arcade: ARCADE_HEIGHT of arches. */
export const PARKING_FLOOR = 3;
export const ARCADE_HEIGHT = 2;
export const CURTAIN_MULLION = 4;

/**
 * Split one wall piece [lo, hi) of a segment into styled pieces: accent band at accFrom, then the facade pattern
 * (only with `patterns`, i.e. LOD0). pos is the column index along the boundary. emit(lo, hi, colorId).
 */
function wallPieces(lo, hi, base, colorId, kind, accFrom, accC, pos, patterns, emit) {
  const styled = (a, b, c) => {
    if (b <= a) return;
    if (!patterns) { emit(a, b, c); return; }
    const facade = kind - 1;
    if (facade === FACADE.RIBBED) { emit(a, b, pos % 2 ? darkOf(c) : c); return; }
    if (facade === FACADE.CURTAIN) { emit(a, b, pos % CURTAIN_MULLION === 0 ? darkOf(c) : c); return; }
    if (facade === FACADE.ARCADE) {
      const split = Math.min(b, Math.max(a, base + ARCADE_HEIGHT));
      if (split > a) emit(a, split, pos % 2 ? darkOf(c) : c);
      if (b > split) emit(split, b, c);
      return;
    }
    if (facade === FACADE.PARKING) {
      let y = a;
      while (y < b) {
        const open = (y - base) % PARKING_FLOOR === 1;
        let e = y + 1;
        while (e < b && ((e - base) % PARKING_FLOOR === 1) === open) e++;
        emit(y, e, open ? darkOf(c) : c);
        y = e;
      }
      return;
    }
    emit(a, b, c);
  };
  if (accFrom !== NO_ACCENT && accFrom < hi) {
    styled(lo, Math.min(hi, accFrom), colorId);
    styled(Math.max(lo, accFrom), hi, accC);
  } else styled(lo, hi, colorId);
}

function meshSides(grid, scale, { uvs, glow, patterns }, opaque, walls) {
  const { w } = grid;
  const pieces = [];
  for (const dir of SIDES) {
    for (let line = 0; line < w; line++) {
      const runs = new Map();
      const close = (run) => {
        const { lo, hi, colorId, kind, dark } = run;
        const q = sideQuad(dir, line, run.start, run.end + 1, lo, hi, scale, uvs);
        const shade = dark ? [SIDE_CONTACT, SIDE_CONTACT, 1, 1] : FLAT;
        (kind === K_ATLAS && walls ? walls : opaque).quad(q.corners, dir.normal, colorId, shade, q.uv, false, glow && glows(kind));
      };
      for (let pos = 0; pos < w; pos++) {
        const i = dir.alongZ ? line : pos;
        const j = dir.alongZ ? pos : line;
        const c = cellAt(grid, i, j);
        pieces.length = 0;
        if (grid.exists[c]) {
          const nb = cellAt(grid, i + dir.di, j + dir.dj);
          const n1 = grid.unknown[nb] ? Math.min(grid.gMin[c], grid.u1[c]) : grid.u1[nb];
          const n2lo = grid.unknown[nb] ? 0 : grid.u2lo[nb];
          const n2hi = grid.unknown[nb] ? 0 : grid.u2hi[nb];
          const paper = grid.paper[nb] === 1;
          const o = c * MAX_SEGS;
          for (let k = 0; k < grid.segN[c]; k++) {
            const a = grid.segLo[o + k], b = grid.segHi[o + k];
            const s = Math.max(a, n1);
            if (s >= b) continue;
            const kind = grid.segKind[o + k];
            const push = (lo, hi, colorId) => {
              const dark = lo === n1 || (n2hi > 0 && lo === n2hi) ? 1 : 0;
              pieces.push(runKey(lo, hi, colorId, kind, dark), lo, hi, colorId, kind, dark);
            };
            const add = (lo, hi) => {
              if (hi <= lo) return;
              if (kind === K_TERRAIN) {
                const segC = grid.segC[o + k];
                push(lo, hi, paper && segC >= C_SIDE && segC < C_DECK_TOP ? C_UNBUILT_SIDE : segC);
              } else {
                wallPieces(lo, hi, a, grid.segC[o + k], kind, grid.segAccFrom[o + k], grid.segAccC[o + k], pos, patterns, push);
              }
            };
            if (n2hi > n2lo) {
              add(s, Math.min(b, n2lo));
              add(Math.max(s, n2hi), b);
            } else add(s, b);
          }
        }
        for (let k = 0; k < pieces.length; k += 6) {
          const key = pieces[k];
          const run = runs.get(key);
          if (run && run.end === pos - 1) run.end = pos;
          else {
            if (run) close(run);
            runs.set(key, { start: pos, end: pos, lo: pieces[k + 1], hi: pieces[k + 2], colorId: pieces[k + 3], kind: pieces[k + 4], dark: pieces[k + 5] });
          }
        }
        for (const [key, run] of runs) if (run.end < pos) { close(run); runs.delete(key); }
      }
      for (const run of runs.values()) close(run);
    }
  }
}

// ---------- props ----------

/** One prop: a 1×1 box from y0 to y1 at local (x, z): 4 sides and a top (the bottom stands on something). */
function emitProp(b, x, z, y0, y1, colorId, glowOn) {
  const x1 = x + 1, z1 = z + 1;
  b.quad([x1, y0, z1, x1, y0, z, x1, y1, z, x1, y1, z1], [1, 0, 0], colorId, FLAT, null, false, glowOn);
  b.quad([x, y0, z, x, y0, z1, x, y1, z1, x, y1, z], [-1, 0, 0], colorId, FLAT, null, false, glowOn);
  b.quad([x, y0, z1, x1, y0, z1, x1, y1, z1, x, y1, z1], [0, 0, 1], colorId, FLAT, null, false, glowOn);
  b.quad([x1, y0, z, x, y0, z, x, y1, z, x1, y1, z], [0, 0, -1], colorId, FLAT, null, false, glowOn);
  b.quad([x, y1, z, x, y1, z1, x1, y1, z1, x1, y1, z], UP, colorId, FLAT, null, false, glowOn);
}

/** Quads per prop (meshChunk / meshRegion LOD1 emit props as 1×1 boxes). */
export const PROP_QUADS = 5;

// ---------- public API ----------

function assertChunk(chunk, what) {
  if (!chunk || typeof chunk !== "object") throw new Error(`mesher: ${what} is not a chunk`);
  if (!Number.isInteger(chunk.cx) || !Number.isInteger(chunk.cz)) throw new Error(`mesher: ${what} has no integer cx, cz`);
  for (const [name, T] of [["ground", Int16Array], ["surface", Uint8Array], ["bldg", Uint16Array], ["deck", Int16Array], ["top", Int16Array]]) {
    if (!(chunk[name] instanceof T) || chunk[name].length !== COLUMNS) throw new Error(`mesher: ${what} ${chunk.cx},${chunk.cz}: ${name} must be a ${T.name}[${COLUMNS}]`);
  }
  if (!Array.isArray(chunk.buildings)) throw new Error(`mesher: ${what} ${chunk.cx},${chunk.cz}: buildings must be an array`);
  if (!Array.isArray(chunk.props)) throw new Error(`mesher: ${what} ${chunk.cx},${chunk.cz}: props must be an array`);
  return chunk;
}

const NEIGHBOURS = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

/** An unbuilt-land neighbour: coarse heights of its CHUNK edge columns facing this chunk (0 = sea). */
function isUnbuiltEdge(nb) {
  return nb && typeof nb === "object" && "unbuilt" in nb;
}

/**
 * LOD0. neighbours = {n, s, e, w}: Chunk | null (absent = water) | {unbuilt: Int16Array[CHUNK]} (landmask land:
 * coarse heights of the neighbour's edge columns, in order along the shared edge). → {opaque, walls, props} MeshBuffers
 */
export function meshChunk(chunk, neighbours) {
  assertChunk(chunk, "chunk");
  if (!neighbours || typeof neighbours !== "object") throw new Error("meshChunk: neighbours {n, s, e, w} required");
  for (const [k, [dx, dz]] of Object.entries(NEIGHBOURS)) {
    const nb = neighbours[k];
    if (nb === undefined) throw new Error(`meshChunk: neighbour ${k} missing (pass null when absent)`);
    if (nb === null) continue;
    if (isUnbuiltEdge(nb)) {
      if (!(nb.unbuilt instanceof Int16Array) || nb.unbuilt.length !== CHUNK) throw new Error(`meshChunk: neighbour ${k} unbuilt edge must be an Int16Array[${CHUNK}]`);
      continue;
    }
    assertChunk(nb, `neighbour ${k}`);
    if (nb.cx !== chunk.cx + dx || nb.cz !== chunk.cz + dz) {
      throw new Error(`meshChunk: neighbour ${k} of ${chunk.cx},${chunk.cz} is ${nb.cx},${nb.cz}, expected ${chunk.cx + dx},${chunk.cz + dz}`);
    }
  }
  const grid = createGrid(CHUNK);
  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const c = cellAt(grid, lx, lz);
      setColumn(grid, c, chunk, lz * CHUNK + lx);
      grid.exists[c] = 1;
    }
  }
  const edge = (nb, cells) => {
    if (!nb) return;
    if (isUnbuiltEdge(nb)) for (const [i, j, , t] of cells) setUnbuilt(grid, cellAt(grid, i, j), nb.unbuilt[t]);
    else for (const [i, j, k] of cells) setColumn(grid, cellAt(grid, i, j), nb, k);
  };
  const L = CHUNK - 1;
  const span = (f) => Array.from({ length: CHUNK }, (_, t) => f(t));
  edge(neighbours.w, span((t) => [-1, t, t * CHUNK + L, t]));
  edge(neighbours.e, span((t) => [CHUNK, t, t * CHUNK, t]));
  edge(neighbours.n, span((t) => [t, -1, L * CHUNK + t, t]));
  edge(neighbours.s, span((t) => [t, CHUNK, t, t]));
  const opaque = createBuilder({ uvs: true });
  const walls = createBuilder({ uvs: true });
  const props = createBuilder({ glow: true });
  const opts = { ao: true, uvs: true, glow: false, patterns: true };
  meshTops(grid, 1, opts, opaque);
  meshSides(grid, 1, opts, opaque, walls);
  for (const p of chunk.props) emitProp(props, p.lx, p.lz, p.y0, p.y1, pal(V_WALL, p.color), p.flags === 1);
  const origin = [chunk.cx * CHUNK, 0, chunk.cz * CHUNK];
  return { opaque: opaque.finish(origin), walls: walls.finish(origin), props: props.finish(origin) };
}

/** Height of column k: its own top on a building column, else its ground. */
const columnTop = (chunk, k) => (chunk.bldg[k] ? chunk.top[k] : chunk.ground[k]);

/** Downsample the f×f columns at (lx0, lz0) of `chunk` into cell c: max top, majority colour at that top. */
function setDownsampled(grid, c, chunk, lx0, lz0, f) {
  let maxH = -1, minG = Infinity, maxDeck = 0;
  for (let z = lz0; z < lz0 + f; z++) {
    for (let x = lx0; x < lx0 + f; x++) {
      const k = z * CHUNK + x;
      const h = columnTop(chunk, k);
      if (h > maxH) maxH = h;
      if (chunk.ground[k] < minG) minG = chunk.ground[k];
      const d = Math.abs(chunk.deck[k]);
      if (d > maxDeck) maxDeck = d;
    }
  }
  let best = -1, bestCount = 0;
  const counts = new Map();
  for (let z = lz0; z < lz0 + f; z++) {
    for (let x = lx0; x < lx0 + f; x++) {
      const k = z * CHUNK + x;
      if (columnTop(chunk, k) !== maxH) continue;
      const key = chunk.bldg[k] ? capColorId(entryOf(chunk, k), maxH) : chunk.surface[k];
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n > bestCount) { bestCount = n; best = k; }
    }
  }
  const s = chunk.surface[best];
  if (chunk.bldg[best]) {
    const B = entryOf(chunk, best);
    setCell(grid, c, B.base, maxH, B, C_SIDE + s, capColorId(B, maxH), maxDeck);
  } else {
    const h = quantizeUp(maxH, f);
    setCell(grid, c, h, h, null, C_SIDE + s, s, maxDeck);
  }
  grid.gMin[c] = minG;
}

/**
 * LOD terrain steps: land above y=1 rounds UP to a multiple of the downsample factor, which halves the
 * hill terraces (and their side quads) per LOD level. Rounding up keeps the max-top rule conservative,
 * so a downsampled cell still covers every column under it and no seam opens toward LOD0.
 */
const quantizeUp = (h, f) => (h <= 1 ? h : Math.ceil(h / f) * f);

/**
 * LOD1 (2×2) / LOD2 (4×4) downsample of one region's chunks (≤ 16, all in the same 4×4 region).
 * skip = [[cx, cz], ...] chunks drawn at LOD0: not emitted, but used as neighbour coverage when present
 * in `chunks`. Region chunks neither given nor skipped are absent (open water or unbuilt land). Cells outside
 * the region are unknown: their side faces skirt down to the cell's lowest ground. LOD1 also draws the
 * chunks' props as 1×1 boxes. → {opaque} MeshBuffers (+ glow)
 */
export function meshRegion(chunks, skip, lod) {
  if (lod !== 1 && lod !== 2) throw new Error(`meshRegion: lod must be 1 or 2, got ${lod}`);
  if (!Array.isArray(chunks) || chunks.length === 0) throw new Error("meshRegion: chunks must be a non-empty array");
  if (chunks.length > REGION * REGION) throw new Error(`meshRegion: ${chunks.length} chunks, a region holds ${REGION * REGION}`);
  if (!Array.isArray(skip)) throw new Error("meshRegion: skip must be an array of [cx, cz]");
  chunks.forEach((c, k) => assertChunk(c, `chunks[${k}]`));
  const [rx, rz] = regionOf(chunks[0].cx, chunks[0].cz);
  const byKey = new Map();
  for (const c of chunks) {
    const [x, z] = regionOf(c.cx, c.cz);
    if (x !== rx || z !== rz) throw new Error(`meshRegion: chunk ${c.cx},${c.cz} is outside region ${rx},${rz}`);
    const key = `${c.cx - rx * REGION}_${c.cz - rz * REGION}`;
    if (byKey.has(key)) throw new Error(`meshRegion: duplicate chunk ${c.cx},${c.cz}`);
    byKey.set(key, c);
  }
  const skipped = new Set();
  for (const s of skip) {
    if (!Array.isArray(s) || s.length !== 2 || !Number.isInteger(s[0]) || !Number.isInteger(s[1])) throw new Error(`meshRegion: bad skip entry ${JSON.stringify(s)}`);
    const [x, z] = regionOf(s[0], s[1]);
    if (x !== rx || z !== rz) throw new Error(`meshRegion: skip ${s[0]},${s[1]} is outside region ${rx},${rz}`);
    skipped.add(`${s[0] - rx * REGION}_${s[1] - rz * REGION}`);
  }
  const f = lod === 1 ? 2 : 4;
  const per = CHUNK / f;
  const w = REGION * per;
  const grid = createGrid(w);
  for (let j = -1; j <= w; j++) {
    for (let i = -1; i <= w; i++) {
      const c = cellAt(grid, i, j);
      if (i < 0 || j < 0 || i >= w || j >= w) { grid.unknown[c] = 1; continue; }
      const key = `${Math.floor(i / per)}_${Math.floor(j / per)}`;
      const chunk = byKey.get(key);
      if (!chunk) {
        if (skipped.has(key)) grid.unknown[c] = 1;
        continue;
      }
      setDownsampled(grid, c, chunk, (i % per) * f, (j % per) * f, f);
      if (!skipped.has(key)) grid.exists[c] = 1;
    }
  }
  const opaque = createBuilder({ glow: true });
  const opts = { ao: false, uvs: false, glow: true, patterns: false };
  meshTops(grid, f, opts, opaque);
  meshSides(grid, f, opts, opaque, null);
  if (lod === 1) {
    for (const c of chunks) {
      const [x, z] = [c.cx - rx * REGION, c.cz - rz * REGION];
      if (skipped.has(`${x}_${z}`)) continue;
      for (const p of c.props) emitProp(opaque, x * CHUNK + p.lx, z * CHUNK + p.lz, p.y0, p.y1, pal(V_WALL, p.color), false);
    }
  }
  return { opaque: opaque.finish([rx * REGION * CHUNK, 0, rz * REGION * CHUNK]) };
}

// ---------- unbuilt land ----------

/**
 * Pure. Coarse height of landmask cell (mx, mz): null for sea or outside, else the cell's coarse ground, at
 * least 1 (land is never at sea level).
 */
function maskLand(mask, mx, mz) {
  if (mx < 0 || mz < 0 || mx >= mask.cellsX || mz >= mask.cellsZ) return null;
  const v = mask.cells[mz * mask.cellsX + mx];
  return v === 0 ? null : Math.max(1, v - 1);
}

/**
 * Coarse heights (blocks) of the CHUNK edge columns of chunk (cx, cz) that face the chunk across `side`
 * ("n" | "s" | "e" | "w" as seen from the listed chunk): the meshChunk {unbuilt} neighbour. 0 = sea.
 */
export function unbuiltEdge(mask, cx, cz, side) {
  const out = new Int16Array(CHUNK);
  const x0 = cx * CHUNK, z0 = cz * CHUNK, L = CHUNK - 1;
  for (let t = 0; t < CHUNK; t++) {
    const [x, z] = side === "w" ? [x0 + L, z0 + t] : side === "e" ? [x0, z0 + t] : side === "n" ? [x0 + t, z0 + L] : side === "s" ? [x0 + t, z0] : [NaN, NaN];
    if (Number.isNaN(x)) throw new Error(`unbuiltEdge: side must be n | s | e | w, got ${JSON.stringify(side)}`);
    out[t] = maskLand(mask, Math.floor(x / LANDMASK_CELL), Math.floor(z / LANDMASK_CELL)) ?? 0;
  }
  return out;
}

/**
 * The unbuilt-land layer (spec-v2 §2): every landmask land cell whose chunk is neither listed nor water, as a
 * LANDMASK_CELL-block voxel at its coarse height in the paper tone. Listed chunks count as neighbours at their
 * own mask height (their skirts meet this layer there); water chunks and sea cells are open. One mesh for the
 * whole grid, origin 0,0,0. mask = decoded landmask; listed / water = [[cx, cz], ...]. → {opaque} MeshBuffers
 */
export function meshUnbuilt(mask, listed, water) {
  if (!mask || !(mask.cells instanceof Uint8Array)) throw new Error("meshUnbuilt: mask must be a decoded landmask");
  const keys = (list, what) => {
    if (!Array.isArray(list)) throw new Error(`meshUnbuilt: ${what} must be an array of [cx, cz]`);
    return new Set(list.map(([cx, cz]) => chunkKey(cx, cz)));
  };
  const L = keys(listed, "listed"), Wt = keys(water, "water");
  const per = CHUNK / LANDMASK_CELL;
  const w = Math.max(mask.cellsX, mask.cellsZ);
  const grid = createGrid(w);
  for (let j = 0; j < mask.cellsZ; j++) {
    for (let i = 0; i < mask.cellsX; i++) {
      const h = maskLand(mask, i, j);
      if (h === null) continue;
      const key = chunkKey(Math.floor(i / per), Math.floor(j / per));
      if (Wt.has(key)) continue;
      const c = cellAt(grid, i, j);
      setCell(grid, c, h, h, null, C_UNBUILT_SIDE, C_UNBUILT_TOP, 0);
      grid.gMin[c] = h;
      if (!L.has(key)) grid.exists[c] = 1;
    }
  }
  const opaque = createBuilder();
  const opts = { ao: false, uvs: false, glow: false, patterns: false };
  meshTops(grid, LANDMASK_CELL, opts, opaque);
  meshSides(grid, LANDMASK_CELL, opts, opaque, null);
  return { opaque: opaque.finish([0, 0, 0]) };
}

function buffersOf(mesh, into) {
  for (const k of ["positions", "normals", "colors", "uvs", "glow", "indices"]) {
    if (mesh[k] && !into.includes(mesh[k].buffer)) into.push(mesh[k].buffer);
  }
  return into;
}

/**
 * Worker entry. req = {id, kind: "chunk", lod: 0, chunk, n, s, e, w} | {id, kind: "region", lod: 1|2, chunks, skip}
 * | {id, kind: "unbuilt", mask, listed, water}.
 * → {reply: {id, opaque, walls?, props?}, transfer: ArrayBuffer[]}
 */
export function handleMeshRequest(req) {
  if (!req || typeof req !== "object") throw new Error("mesh request: not an object");
  const { id } = req;
  if (id === undefined) throw new Error("mesh request: missing id");
  if (req.kind === "chunk") {
    if (req.lod !== 0) throw new Error(`mesh request ${id}: chunk requests are lod 0, got ${req.lod}`);
    const { opaque, walls, props } = meshChunk(req.chunk, { n: req.n, s: req.s, e: req.e, w: req.w });
    return { reply: { id, opaque, walls, props }, transfer: buffersOf(props, buffersOf(walls, buffersOf(opaque, []))) };
  }
  if (req.kind === "region") {
    const { opaque } = meshRegion(req.chunks, req.skip, req.lod);
    return { reply: { id, opaque }, transfer: buffersOf(opaque, []) };
  }
  if (req.kind === "unbuilt") {
    const { opaque } = meshUnbuilt(req.mask, req.listed, req.water);
    return { reply: { id, opaque }, transfer: buffersOf(opaque, []) };
  }
  throw new Error(`mesh request ${id}: unknown kind ${JSON.stringify(req.kind)}`);
}
