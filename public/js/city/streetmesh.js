// Street-level detail for one LOD0 chunk (street.bin, shared/city.js SFS1): lane paint, crosswalks and rails
// as thin decals on each column's top, and furniture / parked cars as small rotated boxes (streetkit.js).
// Pure; used by mesher.js inside the worker. Every piece takes the height of the column under its centre and is
// skipped over buildings, deck pillars and columns outside the chunk (the neighbour chunk draws its part).

import { CHUNK, CROSSWALK_STYLE, ROAD_FLAG, STREET_LINE, STREET_POINT, STREET_Q, SURFACE, TRACK_FLAG, isRoadSurface, rotRad } from "../../shared/city.js";
import {
  BENCH_BOXES, BIN_BOXES, BODY, CAR_BOXES, CAR_COLORS, CURB, HYDRANT_BOXES, LAMP_BOXES, PAINT, SHELTER_BOXES, SIGNAL_BOXES, STOP_BOXES,
  carColorIndex,
} from "./streetkit.js";

const PAINT_Y = 0.012;
const RAIL_Y = 0.022;
const PIECE = 0.5;
/** Centre / lane dashes: DASH blocks of paint every DASH_PERIOD (3 m on, 6 m off). */
export const DASH = 1, DASH_PERIOD = 3;
const LINE_HW = 0.03;
const PARKING_LANE = 0.8;
const ZEBRA_STEP = 0.32, ZEBRA_BAR = 0.16;

const UP = [0, 1, 0];
const FLAT = [1, 1, 1, 1];
const POINT_BOXES = Object.freeze({
  [STREET_POINT.LAMP]: LAMP_BOXES, [STREET_POINT.HYDRANT]: HYDRANT_BOXES, [STREET_POINT.BENCH]: BENCH_BOXES, [STREET_POINT.SHELTER]: SHELTER_BOXES,
  [STREET_POINT.STOP]: STOP_BOXES, [STREET_POINT.CAR]: CAR_BOXES, [STREET_POINT.SIGNAL]: SIGNAL_BOXES, [STREET_POINT.BIN]: BIN_BOXES,
});

/** Column under chunk-local (x, z): {y (drawn top), road, s}, or null (outside the chunk, building, pillar, water). */
function columnTop(chunk, x, z) {
  const lx = Math.floor(x), lz = Math.floor(z);
  if (lx < 0 || lz < 0 || lx >= CHUNK || lz >= CHUNK) return null;
  const k = lz * CHUNK + lx;
  if (chunk.bldg[k] || chunk.deck[k] < 0 || chunk.ground[k] <= 0) return null;
  const s = chunk.surface[k];
  const road = isRoadSurface(s);
  return { y: chunk.ground[k] - (road ? CURB : 0), road, s, k };
}

/** A horizontal quad centred on (cx, cz) with half extents hu along (ux, uz) and hv across, facing up. */
function flatQuad(b, cx, y, cz, ux, uz, hu, hv, colorId) {
  const nx = -uz, nz = ux;
  const p = [
    cx - ux * hu - nx * hv, cz - uz * hu - nz * hv,
    cx + ux * hu - nx * hv, cz + uz * hu - nz * hv,
    cx + ux * hu + nx * hv, cz + uz * hu + nz * hv,
    cx - ux * hu + nx * hv, cz - uz * hu + nz * hv,
  ];
  // counter-clockwise seen from +y: (p1 − p0) × (p2 − p0) must point up
  const up = (p[3] - p[1]) * (p[4] - p[0]) - (p[2] - p[0]) * (p[5] - p[1]);
  const order = up >= 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
  const c = [];
  for (const i of order) c.push(p[i * 2], y, p[i * 2 + 1]);
  b.quad(c, UP, colorId, FLAT, null, false, false);
}

/** Polyline (chunk-local floats) → [{ax, az, ux, uz, len, s0}] segments with arc length. */
function segments(pts) {
  const out = [];
  let s = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2], az = pts[i - 1], bx = pts[i], bz = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len > 1e-6) out.push({ ax, az, ux: (bx - ax) / len, uz: (bz - az) / len, len, s0: s });
    s += len;
  }
  return out;
}

const segNear = (sg, pad) => {
  const ex = sg.ax + sg.ux * sg.len, ez = sg.az + sg.uz * sg.len;
  return Math.max(sg.ax, ex) >= -pad && Math.min(sg.ax, ex) <= CHUNK + pad && Math.max(sg.az, ez) >= -pad && Math.min(sg.az, ez) <= CHUNK + pad;
};

/**
 * Paint a strip along segments at lateral offset `off` (right of travel), half width hw: dashed when period > 0
 * (paint on [k·period, k·period + dash)). keep(col) decides per piece.
 */
function strip(b, chunk, segs, off, hw, colorId, period, dash, lift, keep) {
  for (const sg of segs) {
    if (!segNear(sg, Math.abs(off) + 1)) continue;
    const nx = -sg.uz, nz = sg.ux;
    const runs = [];
    if (period > 0) {
      for (let k = Math.floor(sg.s0 / period); k * period < sg.s0 + sg.len; k++) {
        const a = Math.max(sg.s0, k * period), e = Math.min(sg.s0 + sg.len, k * period + dash);
        if (e > a) runs.push([a - sg.s0, e - sg.s0]);
      }
    } else runs.push([0, sg.len]);
    for (const [a, e] of runs) {
      const n = Math.max(1, Math.ceil((e - a) / PIECE));
      const step = (e - a) / n;
      for (let i = 0; i < n; i++) {
        const t = a + step * (i + 0.5);
        const cx = sg.ax + sg.ux * t + nx * off, cz = sg.az + sg.uz * t + nz * off;
        const col = columnTop(chunk, cx, cz);
        if (!col || !keep(col)) continue;
        flatQuad(b, cx, col.y + lift, cz, sg.ux, sg.uz, step / 2, hw, colorId);
      }
    }
  }
}

/** Columns where two road lines of different direction overlap (junction boxes) get no lane paint. */
function junctionColumns(roads) {
  const angle = new Float32Array(CHUNK * CHUNK).fill(NaN);
  const junction = new Uint8Array(CHUNK * CHUNK);
  for (const { segs, half } of roads) {
    for (const sg of segs) {
      if (!segNear(sg, half + 1)) continue;
      const a = Math.atan2(sg.uz, sg.ux);
      const ex = sg.ax + sg.ux * sg.len, ez = sg.az + sg.uz * sg.len;
      const x0 = Math.max(0, Math.floor(Math.min(sg.ax, ex) - half)), x1 = Math.min(CHUNK - 1, Math.floor(Math.max(sg.ax, ex) + half));
      const z0 = Math.max(0, Math.floor(Math.min(sg.az, ez) - half)), z1 = Math.min(CHUNK - 1, Math.floor(Math.max(sg.az, ez) + half));
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5 - sg.ax, pz = z + 0.5 - sg.az;
          const t = Math.max(0, Math.min(sg.len, px * sg.ux + pz * sg.uz));
          if (Math.hypot(px - sg.ux * t, pz - sg.uz * t) > half) continue;
          const k = z * CHUNK + x;
          if (Number.isNaN(angle[k])) { angle[k] = a; continue; }
          let d = Math.abs(angle[k] - a) % Math.PI;
          if (d > Math.PI / 2) d = Math.PI - d;
          if (d > 0.45) junction[k] = 1;
        }
      }
    }
  }
  return junction;
}

/** Box list at (px, y, pz) turned by yaw; colour ids from kitColor(hex), BODY → body. */
function emitBoxes(b, boxes, px, y, pz, yaw, kitColor, body) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const X = (lx, lz) => px + lx * c + lz * s;
  const Z = (lx, lz) => pz - lx * s + lz * c;
  for (const bx of boxes) {
    const colorId = kitColor(bx.color === BODY ? body : bx.color);
    const x0 = bx.x - bx.w / 2, x1 = bx.x + bx.w / 2, z0 = bx.z - bx.d / 2, z1 = bx.z + bx.d / 2;
    const y0 = y + bx.y, y1 = y0 + bx.h;
    const P = (lx, yy, lz) => [X(lx, lz), yy, Z(lx, lz)];
    const face = (pts, n) => b.quad(pts.flat(), [n[0] * c + n[2] * s, n[1], -n[0] * s + n[2] * c], colorId, FLAT, null, false, !!bx.glow);
    face([P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1)], [1, 0, 0]);
    face([P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], [-1, 0, 0]);
    face([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], [0, 0, 1]);
    face([P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0)], [0, 0, -1]);
    face([P(x0, y1, z0), P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0)], [0, 1, 0]);
  }
}

/** Quads one street point emits (checks and the perf budget). */
export const pointQuads = (kind) => POINT_BOXES[kind].length * 5;

/**
 * street = {lines, points} (street.bin entries touching this chunk). decals and props are mesher builders;
 * kitColor(hex) → colour id. Decals go to `decals`, furniture and cars to `props` (lamp heads glow).
 */
export function meshStreet(chunk, street, decals, props, kitColor) {
  const ox = chunk.cx * CHUNK, oz = chunk.cz * CHUNK;
  const local = (pts) => {
    const out = new Float32Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) { out[i] = pts[i] / STREET_Q - ox; out[i + 1] = pts[i + 1] / STREET_Q - oz; }
    return out;
  };
  const white = kitColor(PAINT.white), yellow = kitColor(PAINT.yellow);
  const roads = [], crossings = [], tracks = [];
  for (const l of street.lines) {
    const item = { l, segs: segments(local(l.pts)), half: l.width4 / STREET_Q / 2 };
    if (l.kind === STREET_LINE.ROAD) roads.push(item);
    else if (l.kind === STREET_LINE.CROSSWALK) crossings.push(item);
    else if (l.kind === STREET_LINE.TRACK) tracks.push(item);
  }

  // crosswalks first: their columns get no lane paint
  const blocked = junctionColumns(roads);
  const onCarriageway = (col) => col.road || col.s === SURFACE.RAIL;
  for (const { l, segs } of crossings) {
    const band = (l.width4 / STREET_Q) / 2;
    for (const sg of segs) {
      if (!segNear(sg, 2)) continue;
      const nx = -sg.uz, nz = sg.ux;
      if (l.flags !== CROSSWALK_STYLE.LINES) {
        for (let t = ZEBRA_STEP / 2; t < sg.len; t += ZEBRA_STEP) {
          const cx = sg.ax + sg.ux * t, cz = sg.az + sg.uz * t;
          const col = columnTop(chunk, cx, cz);
          if (!col || !onCarriageway(col)) continue;
          blocked[col.k] = 1;
          flatQuad(decals, cx, col.y + PAINT_Y, cz, nx, nz, band * 0.9, ZEBRA_BAR / 2, white);
        }
      }
      if (l.flags !== CROSSWALK_STYLE.ZEBRA) {
        for (const side of [-1, 1]) strip(decals, chunk, [sg], side * band, 0.05, white, 0, 0, PAINT_Y, (col) => onCarriageway(col) && ((blocked[col.k] = 1), true));
      }
    }
  }

  const paintable = (col) => col.road && !blocked[col.k];
  for (const { l, segs, half } of roads) {
    if (l.flags & ROAD_FLAG.DOUBLE_YELLOW) {
      strip(decals, chunk, segs, -0.07, LINE_HW, yellow, 0, 0, PAINT_Y, paintable);
      strip(decals, chunk, segs, 0.07, LINE_HW, yellow, 0, 0, PAINT_Y, paintable);
    } else if (l.flags & ROAD_FLAG.CENTRE) strip(decals, chunk, segs, 0, LINE_HW, yellow, DASH_PERIOD, DASH, PAINT_Y, paintable);
    const oneway = (l.flags & ROAD_FLAG.ONEWAY) !== 0;
    const perSide = oneway ? l.lanes : Math.floor(l.lanes / 2);
    if (perSide >= 2) {
      const drive = oneway ? 2 * half - 2 * PARKING_LANE : half - PARKING_LANE;
      const lane = drive / perSide;
      if (lane > 0.6) {
        for (let k = 1; k < perSide; k++) {
          if (oneway) strip(decals, chunk, segs, -half + PARKING_LANE + k * lane, LINE_HW, white, DASH_PERIOD, DASH, PAINT_Y, paintable);
          else for (const side of [-1, 1]) strip(decals, chunk, segs, side * k * lane, LINE_HW, white, DASH_PERIOD, DASH, PAINT_Y, paintable);
        }
      }
    }
  }

  const rail = kitColor(PAINT.rail), slot = kitColor(PAINT.slot), sleeper = kitColor(PAINT.sleeper);
  const anyGround = () => true;
  for (const { l, segs, half } of tracks) {
    if (l.flags & TRACK_FLAG.MEDIAN) strip(decals, chunk, segs, 0, half + 0.12, sleeper, 0.6, 0.14, PAINT_Y, anyGround);
    for (const side of [-1, 1]) strip(decals, chunk, segs, side * half, 0.025, rail, 0, 0, RAIL_Y, anyGround);
    if (l.flags & TRACK_FLAG.CABLE) strip(decals, chunk, segs, 0, 0.015, slot, 0, 0, PAINT_Y, anyGround);
  }

  for (const p of street.points) {
    const x = p.x4 / STREET_Q - ox, z = p.z4 / STREET_Q - oz;
    const col = columnTop(chunk, x, z);
    if (!col) continue;
    const boxes = POINT_BOXES[p.kind];
    if (!boxes) throw new Error(`streetmesh: unknown point kind ${p.kind}`);
    const body = p.kind === STREET_POINT.CAR ? CAR_COLORS[carColorIndex(p.x4, p.z4)] : null;
    emitBoxes(props, boxes, x, col.y, z, rotRad(p.rot), kitColor, body);
  }
}

export { emitBoxes };

/**
 * Pure. street.bin → Map "cx_cz" → {lines, points}: a line goes to every chunk its segments' boxes (padded by
 * half its width + 1) touch, a point to the chunk that holds it.
 */
export function binStreet(street) {
  const bins = new Map();
  const bin = (cx, cz) => {
    const key = `${cx}_${cz}`;
    let b = bins.get(key);
    if (!b) { b = { lines: [], points: [] }; bins.set(key, b); }
    return b;
  };
  for (const l of street.lines) {
    const pad = l.width4 / STREET_Q / 2 + 1;
    const seen = new Set();
    for (let i = 2; i < l.pts.length; i += 2) {
      const ax = l.pts[i - 2] / STREET_Q, az = l.pts[i - 1] / STREET_Q, bx = l.pts[i] / STREET_Q, bz = l.pts[i + 1] / STREET_Q;
      const cx0 = Math.floor((Math.min(ax, bx) - pad) / CHUNK), cx1 = Math.floor((Math.max(ax, bx) + pad) / CHUNK);
      const cz0 = Math.floor((Math.min(az, bz) - pad) / CHUNK), cz1 = Math.floor((Math.max(az, bz) + pad) / CHUNK);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${cx}_${cz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bin(cx, cz).lines.push(l);
      }
    }
  }
  for (const p of street.points) bin(Math.floor(p.x4 / STREET_Q / CHUNK), Math.floor(p.z4 / STREET_Q / CHUNK)).points.push(p);
  return bins;
}
