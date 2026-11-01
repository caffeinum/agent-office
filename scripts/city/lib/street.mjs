// The street-level detail layer (street.bin, public/shared/city.js SFS1): road centrelines with marking flags,
// crosswalks, tram / cable-car / light-rail track, and street furniture. Real OSM features first (lamps,
// hydrants, benches, bins, bus stops, signals, crossings, track); then sparse procedural lamps and hydrants on
// sidewalks, and parked cars along kerbs (never on crosswalks, near junctions, driveways, stops or hydrants).
// Everything is checked against the finished raster: furniture stands on open ground, parked cars on asphalt.
import {
  CROSSWALK_STYLE, ROAD_FLAG, STREET_LINE, STREET_POINT, STREET_Q, SURFACE, TRACK_FLAG, isRoadSurface, rotByte, streetQ,
} from "../../../public/shared/city.js";
import { highwayClass, keepHighway, layerOf, roadSpec } from "./osm.mjs";
import { rasterIndex } from "./raster.mjs";

/** Car classes drawn as ROAD lines (markings, traffic); service ways are driveways and alleys. */
const CAR_CLASSES = new Set(["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "busway"]);
const MAJOR = new Set(["trunk", "primary", "secondary"]);
const ARTERIAL = new Set(["trunk", "primary", "secondary", "tertiary"]);
const PARKING_CLASSES = new Set(["primary", "secondary", "tertiary", "residential", "unclassified"]);
const NO_PARKING_NAMES = new Set(["Market Street", "The Embarcadero", "Van Ness Avenue"]);

export const LAMP_SPACING = { arterial: 10, residential: 16 };
export const HYDRANT_SPACING = 34;
export const CAR_SLOT = 2.3;
export const CAR_SHARE = 0.42;
/** Clearances (blocks) around a parked car. */
const CLEAR = { crosswalk: 2.5, junction: 4, driveway: 1.6, stop: 3, hydrant: 1.2, track: 1.4, signal: 2 };
const CROSSWALK_W = 1;

const OPEN_GROUND = new Set([SURFACE.SIDEWALK, SURFACE.PLAZA, SURFACE.PARK, SURFACE.GRASS, SURFACE.PARKING, SURFACE.HILL, SURFACE.DIRT, SURFACE.FOREST, SURFACE.PIER]);

function hash2(a, b) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}

/** A uniform grid over segments / points for radius queries. */
function createIndex(cell = 4) {
  const cells = new Map();
  const key = (cx, cz) => `${cx},${cz}`;
  return {
    addPoint(x, z, item) {
      const k = key(Math.floor(x / cell), Math.floor(z / cell));
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push({ x, z, item });
    },
    addSeg(ax, az, bx, bz, item) {
      const x0 = Math.floor(Math.min(ax, bx) / cell), x1 = Math.floor(Math.max(ax, bx) / cell);
      const z0 = Math.floor(Math.min(az, bz) / cell), z1 = Math.floor(Math.max(az, bz) / cell);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
        const k = key(cx, cz);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push({ ax, az, bx, bz, item });
      }
    },
    near(x, z, r, fn) {
      const x0 = Math.floor((x - r) / cell), x1 = Math.floor((x + r) / cell), z0 = Math.floor((z - r) / cell), z1 = Math.floor((z + r) / cell);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) for (const e of cells.get(key(cx, cz)) ?? []) fn(e);
    },
  };
}

/** Distance from (x, z) to segment a-b, and the segment parameter t. */
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  return { d: Math.hypot(x - (ax + dx * t), z - (az + dz * t)), t };
}

const anyNear = (index, x, z, r, test = () => true) => {
  let hit = false;
  index.near(x, z, r, (e) => {
    if (hit || !test(e.item)) return;
    const d = e.ax !== undefined ? segDist(x, z, e.ax, e.az, e.bx, e.bz).d : Math.hypot(e.x - x, e.z - z);
    if (d <= r) hit = true;
  });
  return hit;
};

/** Walk a polyline, calling fn(x, z, dx, dz, s) every `step` blocks from `start` (dx, dz the unit direction). */
function along(pts, step, start, fn) {
  let s = 0, next = start;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const len = Math.hypot(bx - ax, bz - az);
    if (len === 0) continue;
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    while (next <= s + len) {
      const t = next - s;
      fn(ax + dx * t, az + dz * t, dx, dz, next);
      next += step;
    }
    s += len;
  }
  return s;
}

const yawOf = (dx, dz) => Math.atan2(dx, dz);
/** Points are stored in quarter blocks: every column test runs on the stored position. */
const snapQ = (v) => streetQ(v) / STREET_Q;
const isOneway = (t) => t.oneway === "yes" || t.oneway === "1" || t.oneway === "true" || t.oneway === "-1" || t.junction === "roundabout";
const lanesOf = (t) => {
  const n = Number(String(t.lanes ?? "").split(";")[0]);
  return Number.isInteger(n) && n > 0 ? Math.min(15, n) : 0;
};

/**
 * → {doc: {lines, points} (street.bin), report}. roads: OSM highway ways; street: the `street` fetch (furniture
 * nodes, track ways); toBlock(lon, lat) → [x, z]; isDeck(tags, line) → true for ways drawn as decks; inArea(x, z)
 * → true inside a shipped area chunk.
 */
export function buildStreet({ raster, roads, street, toBlock, isDeck, inArea }) {
  const report = { lines: {}, points: {}, osm: {}, procedural: {}, dropped: {} };
  const inc = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
  const col = (x, z) => {
    const i = rasterIndex(raster, Math.floor(x), Math.floor(z));
    return i < 0 ? null : { i, s: raster.surface[i], g: raster.ground[i], bldg: raster.owner[i] >= 0, deck: raster.deck[i] };
  };
  const open = (x, z) => {
    const c = col(x, z);
    return c && c.g > 0 && !c.bldg && c.deck >= 0 && OPEN_GROUND.has(c.s) && inArea(x, z) ? c : null;
  };
  const onRoad = (x, z) => {
    const c = col(x, z);
    return c && c.g > 0 && !c.bldg && c.deck >= 0 && isRoadSurface(c.s) ? c : null;
  };
  const lines = [];
  const points = [];
  const pushLine = (kind, flags, width, lanes, pts) => {
    if (pts.length < 2 || !pts.some(([x, z]) => inArea(x, z))) return false;
    const q = new Int16Array(pts.length * 2);
    pts.forEach(([x, z], k) => { q[k * 2] = streetQ(x); q[k * 2 + 1] = streetQ(z); });
    lines.push({ kind, flags, width4: Math.max(1, Math.min(255, Math.round(width * STREET_Q))), lanes, pts: q });
    inc(report.lines, kind === STREET_LINE.ROAD ? "road" : kind === STREET_LINE.CROSSWALK ? "crosswalk" : (flags & TRACK_FLAG.CABLE ? "cable" : "track"));
    return true;
  };
  const pushPoint = (kind, x, z, yaw, src) => {
    points.push({ kind, rot: rotByte(yaw), x4: streetQ(x), z4: streetQ(z) });
    inc(report.points, Object.keys(STREET_POINT).find((k) => STREET_POINT[k] === kind));
    inc(src === "osm" ? report.osm : report.procedural, Object.keys(STREET_POINT).find((k) => STREET_POINT[k] === kind));
  };

  // ---------- roads ----------
  const roadIdx = createIndex(6);
  const junctions = new Map();
  const vkey = (x, z) => `${Math.round(x * 8)},${Math.round(z * 8)}`;
  const roadLines = [];
  const driveways = createIndex(4);
  for (const e of roads) {
    const t = e.tags ?? {};
    if (!keepHighway(t) || !Array.isArray(e.geometry) || e.geometry.length < 2) continue;
    const cls = highwayClass(t.highway);
    const spec = roadSpec(t);
    if (!spec) continue;
    let pts = e.geometry.map((p) => toBlock(p.lon, p.lat));
    if (isDeck(t, pts)) continue;
    if (cls === "service") {
      for (let k = 0; k < pts.length; k++) driveways.addPoint(pts[k][0], pts[k][1], true);
      for (const p of pts) junctions.set(vkey(p[0], p[1]), (junctions.get(vkey(p[0], p[1])) ?? 0) + 1);
      continue;
    }
    if (!CAR_CLASSES.has(cls)) continue;
    if (t.oneway === "-1") pts = pts.slice().reverse();
    const oneway = isOneway(t);
    const lanes = lanesOf(t);
    let flags = oneway ? ROAD_FLAG.ONEWAY : 0;
    if (MAJOR.has(cls)) flags |= ROAD_FLAG.MAJOR;
    if (!oneway && spec.roadway >= 3 && cls !== "living_street" && cls !== "busway") {
      if (ARTERIAL.has(cls)) flags |= ROAD_FLAG.DOUBLE_YELLOW;
      else if (spec.roadway >= 4 || lanes >= 2) flags |= ROAD_FLAG.CENTRE;
    }
    const rl = { pts, half: spec.roadway / 2, cls, oneway, lanes, name: t.name ?? "", flags };
    if (!pushLine(STREET_LINE.ROAD, flags, spec.roadway, lanes, pts)) continue;
    roadLines.push(rl);
    for (let k = 1; k < pts.length; k++) roadIdx.addSeg(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], rl);
    for (const p of pts) junctions.set(vkey(p[0], p[1]), (junctions.get(vkey(p[0], p[1])) ?? 0) + 1);
  }
  // a vertex shared by two or more ways (or a way's interior touching another) is a junction
  const junctionIdx = createIndex(6);
  for (const rl of roadLines) {
    rl.pts.forEach(([x, z], k) => {
      const n = junctions.get(vkey(x, z)) ?? 0;
      const end = k === 0 || k === rl.pts.length - 1;
      if (n >= 2 || (end && n >= 1 && rl.pts.length > 1 && anyNear(roadIdx, x, z, 0.5, (o) => o !== rl))) junctionIdx.addPoint(x, z, rl.half);
    });
  }

  /** Nearest road line within r: {rl, dx, dz (unit along), side (+1 right of travel), d}. */
  const nearestRoad = (x, z, r) => {
    let best = null;
    roadIdx.near(x, z, r, (e) => {
      const { d } = segDist(x, z, e.ax, e.az, e.bx, e.bz);
      if (d > r || (best && d >= best.d)) return;
      const l = Math.hypot(e.bx - e.ax, e.bz - e.az) || 1;
      const dx = (e.bx - e.ax) / l, dz = (e.bz - e.az) / l;
      const cross = (x - e.ax) * -dz + (z - e.az) * dx;
      best = { rl: e.item, dx, dz, d, side: cross >= 0 ? 1 : -1 };
    });
    return best;
  };
  /** Yaw facing the nearest road from (x, z), or a hashed yaw when none is near. */
  const faceRoad = (x, z) => {
    const r = nearestRoad(x, z, 8);
    if (!r) return hash2(Math.round(x * 4), Math.round(z * 4)) * Math.PI * 2;
    // right normal of travel is (-dz, dx): a point on side s faces the road along -s·normal
    return yawOf(r.dz * r.side, -r.dx * r.side);
  };

  // ---------- crosswalks ----------
  const crossIdx = createIndex(4);
  const crossStyle = (t) => {
    const m = String(t["crossing:markings"] ?? "");
    if (m === "ladder" || m === "ladder:skewed" || m === "ladder:paired") return CROSSWALK_STYLE.LADDER;
    if (m === "lines" || m === "dashes" || m === "dots") return CROSSWALK_STYLE.LINES;
    if (m === "zebra" || m === "zebra:double" || m === "zebra:paired") return CROSSWALK_STYLE.ZEBRA;
    return t.crossing === "traffic_signals" ? CROSSWALK_STYLE.LADDER : CROSSWALK_STYLE.ZEBRA;
  };
  const marked = (t) => {
    const c = String(t.crossing ?? "");
    if (c.startsWith("unmarked") || c === "no" || c === "informal") return false;
    return t["crossing:markings"] !== "no";
  };
  for (const e of roads) {
    const t = e.tags ?? {};
    if (t.footway !== "crossing" && t.cycleway !== "crossing" && t.path !== "crossing") continue;
    if (!marked(t) || !Array.isArray(e.geometry) || e.geometry.length < 2 || layerOf(t)) continue;
    const pts = e.geometry.map((p) => toBlock(p.lon, p.lat));
    if (!pts.some(([x, z]) => onRoad(x, z))) { inc(report.dropped, "crosswalkOffRoad"); continue; }
    if (!pushLine(STREET_LINE.CROSSWALK, crossStyle(t), CROSSWALK_W, 0, pts)) continue;
    for (let k = 1; k < pts.length; k++) crossIdx.addSeg(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], true);
  }
  // crossing nodes with no crossing way: a band across the road, perpendicular to it
  const nodes = street.filter((e) => e.type === "node");
  for (const e of nodes) {
    const t = e.tags ?? {};
    if (t.highway !== "crossing" || !marked(t)) continue;
    const [x, z] = toBlock(e.lon, e.lat);
    if (anyNear(crossIdx, x, z, 1.5) || !onRoad(x, z)) continue;
    const r = nearestRoad(x, z, 1.2);
    if (!r) continue;
    const h = r.rl.half + 0.2;
    const pts = [[x + r.dz * h, z - r.dx * h], [x - r.dz * h, z + r.dx * h]];
    if (pushLine(STREET_LINE.CROSSWALK, crossStyle(t), CROSSWALK_W, 0, pts)) {
      crossIdx.addSeg(pts[0][0], pts[0][1], pts[1][0], pts[1][1], true);
      inc(report.osm, "crossingNodes");
    }
  }

  // ---------- track ----------
  const trackIdx = createIndex(4);
  for (const e of street) {
    const t = e.tags ?? {};
    if (e.type !== "way" || (t.railway !== "tram" && t.railway !== "light_rail")) continue;
    if ((t.tunnel && t.tunnel !== "no") || (layerOf(t) ?? -1) < 0 || (layerOf(t) ?? 0) > 0 || t.bridge) { inc(report.dropped, "trackTunnelOrBridge"); continue; }
    if (!Array.isArray(e.geometry) || e.geometry.length < 2) continue;
    const pts = e.geometry.map((p) => toBlock(p.lon, p.lat));
    const cable = t.cable_tram === "cable" || (t.railway === "tram" && t.electrified === "no");
    const mid = pts[Math.floor(pts.length / 2)];
    const median = col(mid[0], mid[1])?.s === SURFACE.RAIL;
    const flags = (cable ? TRACK_FLAG.CABLE : 0) | (median ? TRACK_FLAG.MEDIAN : 0);
    if (!pushLine(STREET_LINE.TRACK, flags, cable ? 1.07 / 3 : 1.435 / 3, 0, pts)) continue;
    for (let k = 1; k < pts.length; k++) trackIdx.addSeg(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], true);
  }

  // ---------- OSM furniture ----------
  const furnIdx = createIndex(4);
  const lampIdx = createIndex(6);
  const stopIdx = createIndex(6);
  const hydrantIdx = createIndex(6);
  const signalIdx = createIndex(6);
  /** A kerbside spot for (x, z): itself when it is open ground, else pushed off the nearest road onto its sidewalk. */
  const kerbside = (x, z) => {
    if (open(snapQ(x), snapQ(z))) return [snapQ(x), snapQ(z)];
    const r = nearestRoad(x, z, 6);
    if (!r) return null;
    const out = r.rl.half + 0.45;
    const nx = -r.dz * r.side, nz = r.dx * r.side;
    const px = snapQ(x + nx * (out - r.d)), pz = snapQ(z + nz * (out - r.d));
    return open(px, pz) ? [px, pz] : null;
  };
  const seenStops = [];
  for (const e of nodes) {
    const t = e.tags ?? {};
    const [x0, z0] = toBlock(e.lon, e.lat);
    if (!inArea(x0, z0)) continue;
    let kind = null;
    if (t.highway === "street_lamp") kind = STREET_POINT.LAMP;
    else if (t.emergency === "fire_hydrant") kind = STREET_POINT.HYDRANT;
    else if (t.amenity === "bench") kind = STREET_POINT.BENCH;
    else if (t.amenity === "waste_basket") kind = STREET_POINT.BIN;
    else if (t.highway === "bus_stop" || t.public_transport === "platform") kind = t.shelter === "yes" ? STREET_POINT.SHELTER : STREET_POINT.STOP;
    if (kind === null) continue;
    const own = open(snapQ(x0), snapQ(z0)) ? [snapQ(x0), snapQ(z0)] : null;
    const spot = kind === STREET_POINT.BENCH || kind === STREET_POINT.BIN ? (own ?? kerbside(x0, z0)) : kerbside(x0, z0);
    if (!spot) { inc(report.dropped, `osm${kind}`); continue; }
    const [x, z] = spot;
    if (kind === STREET_POINT.SHELTER || kind === STREET_POINT.STOP) {
      const dup = seenStops.find((s) => Math.hypot(s.x - x, s.z - z) < 3);
      if (dup) { if (kind === STREET_POINT.SHELTER && dup.p.kind === STREET_POINT.STOP) dup.p.kind = STREET_POINT.SHELTER; continue; }
    }
    if (anyNear(furnIdx, x, z, 0.5)) { inc(report.dropped, "overlap"); continue; }
    pushPoint(kind, x, z, faceRoad(x, z), "osm");
    furnIdx.addPoint(x, z, kind);
    if (kind === STREET_POINT.LAMP) lampIdx.addPoint(x, z, true);
    if (kind === STREET_POINT.HYDRANT) hydrantIdx.addPoint(x, z, true);
    if (kind === STREET_POINT.SHELTER || kind === STREET_POINT.STOP) { stopIdx.addPoint(x, z, true); seenStops.push({ x, z, p: points[points.length - 1] }); }
  }

  // signals: a pole at each kerb corner of an intersection with a highway=traffic_signals node
  for (const e of nodes) {
    if (e.tags?.highway !== "traffic_signals") continue;
    const [x, z] = toBlock(e.lon, e.lat);
    if (!inArea(x, z)) continue;
    const through = [];
    roadIdx.near(x, z, 1, (s) => {
      const { d } = segDist(x, z, s.ax, s.az, s.bx, s.bz);
      if (d > 0.6) return;
      const l = Math.hypot(s.bx - s.ax, s.bz - s.az) || 1;
      through.push({ dx: (s.bx - s.ax) / l, dz: (s.bz - s.az) / l, half: s.item.half });
    });
    if (!through.length) continue;
    const a = through[0];
    const b = through.find((o) => Math.abs(o.dx * a.dx + o.dz * a.dz) < 0.8) ?? { dx: -a.dz, dz: a.dx, half: a.half };
    for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
      const px = snapQ(x + a.dx * sa * (b.half + 0.5) + b.dx * sb * (a.half + 0.5));
      const pz = snapQ(z + a.dz * sa * (b.half + 0.5) + b.dz * sb * (a.half + 0.5));
      if (!open(px, pz) || anyNear(signalIdx, px, pz, 1.5) || anyNear(furnIdx, px, pz, 0.5)) continue;
      // the head faces traffic arriving along a toward the corner's side
      pushPoint(STREET_POINT.SIGNAL, px, pz, yawOf(-a.dx * sa, -a.dz * sa), "osm");
      signalIdx.addPoint(px, pz, true);
      furnIdx.addPoint(px, pz, STREET_POINT.SIGNAL);
    }
  }

  // ---------- procedural lamps and hydrants, kerbside ----------
  const kerbSpot = (rl, x, z, dx, dz, side, inset) => {
    const off = rl.half + inset;
    return [snapQ(x - dz * off * side), snapQ(z + dx * off * side)];
  };
  for (const rl of roadLines) {
    const arterial = ARTERIAL.has(rl.cls);
    if (!arterial && rl.cls !== "residential" && rl.cls !== "unclassified") continue;
    const step = arterial ? LAMP_SPACING.arterial : LAMP_SPACING.residential;
    for (const side of [1, -1]) {
      const phase = (side > 0 ? 0.5 : 0) * step + 2;
      along(rl.pts, step, phase, (x, z, dx, dz) => {
        const [px, pz] = kerbSpot(rl, x, z, dx, dz, side, 0.3);
        if (!open(px, pz) || anyNear(lampIdx, px, pz, step * 0.6) || anyNear(crossIdx, px, pz, 1.2) || anyNear(furnIdx, px, pz, 0.8)) return;
        pushPoint(STREET_POINT.LAMP, px, pz, yawOf(dz * side, -dx * side), "proc");
        lampIdx.addPoint(px, pz, true);
        furnIdx.addPoint(px, pz, STREET_POINT.LAMP);
      });
    }
    along(rl.pts, HYDRANT_SPACING, 7 + hash2(rl.pts.length, Math.round(rl.pts[0][0])) * 10, (x, z, dx, dz) => {
      const side = hash2(Math.round(x), Math.round(z)) < 0.5 ? 1 : -1;
      const [px, pz] = kerbSpot(rl, x, z, dx, dz, side, 0.25);
      if (!open(px, pz) || anyNear(hydrantIdx, px, pz, HYDRANT_SPACING * 0.6) || anyNear(furnIdx, px, pz, 0.8)) return;
      pushPoint(STREET_POINT.HYDRANT, px, pz, yawOf(dz * side, -dx * side), "proc");
      hydrantIdx.addPoint(px, pz, true);
      furnIdx.addPoint(px, pz, STREET_POINT.HYDRANT);
    });
  }

  // ---------- parked cars ----------
  let tried = 0;
  for (const rl of roadLines) {
    if (!PARKING_CLASSES.has(rl.cls) || NO_PARKING_NAMES.has(rl.name) || rl.half < 1.5) continue;
    if (rl.cls === "primary" && rl.lanes > 4) continue;
    for (const side of [1, -1]) {
      along(rl.pts, CAR_SLOT, 1 + (side > 0 ? 0 : CAR_SLOT / 2), (x, z, dx, dz) => {
        tried++;
        const [px, pz] = kerbSpot(rl, x, z, dx, dz, side, -0.38);
        if (hash2(Math.round(px * 4), Math.round(pz * 4)) > CAR_SHARE) return;
        const ok = onRoad(px + dx * 0.7, pz + dz * 0.7) && onRoad(px - dx * 0.7, pz - dz * 0.7) && onRoad(px, pz) && inArea(px, pz);
        if (!ok) { inc(report.dropped, "carOffRoad"); return; }
        if (anyNear(crossIdx, px, pz, CLEAR.crosswalk) || anyNear(junctionIdx, px, pz, CLEAR.junction) || anyNear(driveways, px, pz, CLEAR.driveway)
          || anyNear(stopIdx, px, pz, CLEAR.stop) || anyNear(hydrantIdx, px, pz, CLEAR.hydrant + 0.6) || anyNear(trackIdx, px, pz, CLEAR.track)
          || anyNear(signalIdx, px, pz, CLEAR.signal)) { inc(report.dropped, "carClearance"); return; }
        const fwd = rl.oneway || side > 0;
        pushPoint(STREET_POINT.CAR, px, pz, fwd ? yawOf(dx, dz) : yawOf(-dx, -dz), "proc");
      });
    }
  }
  report.carSlotsTried = tried;
  return { doc: { lines, points }, report };
}
