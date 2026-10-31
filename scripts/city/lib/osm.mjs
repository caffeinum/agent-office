// Overpass queries and OSM tag → city class rules (spec §2, spec-v2 §3).
import { SURFACE } from "../../../public/shared/city.js";

export const OVERPASS_PREFIX = "[out:json][timeout:300][maxsize:1073741824];";

const EXTRA = Object.freeze([
  '["building:part"]',
  '["leisure"~"^(stadium|track|sports_centre|dog_park|swimming_pool)$"]',
  '["amenity"="fountain"]',
  '["water"~"^(pond|fountain|reflecting_pool|basin)$"]',
]);

/**
 * → {roads, land, buildings, extra, points, trees, coastline} query strings, each prefixed
 * [out:json][timeout:300][maxsize:1073741824]. roads/land/buildings are the v1 strings unchanged, so cached
 * requests stay valid (roads already carries highway=busway). spec-v2 §3.1 adds `extra` (building:part, sports,
 * dog-park, pool and fountain areas, ponds), `points` (lighting towers, masts, towers, flagpoles) and `trees`.
 * Queries that return relations end in `out geom;` rather than the spec's `out geom tags;`: the `tags`
 * verbosity drops relation members, so multipolygons would arrive without geometry. Default (body)
 * verbosity still carries every tag.
 */
export function overpassQueries(bbox) {
  const b = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`;
  const land = [
    `wr["leisure"~"^(park|garden|pitch|golf_course)$"]${b};`,
    `wr["landuse"~"^(grass|forest|cemetery|recreation_ground|railway)$"]${b};`,
    `wr["natural"~"^(wood|water|sand|beach|scrub|grassland)$"]${b};`,
    `wr["man_made"="pier"]${b};`,
    `way["railway"~"^(rail|light_rail)$"]${b};`,
    `wr["amenity"="parking"]${b};`,
    `wr["highway"="pedestrian"]["area"="yes"]${b};`,
  ].join("");
  return {
    roads: `${OVERPASS_PREFIX}way["highway"]${b};out geom tags;`,
    land: `${OVERPASS_PREFIX}(${land});out geom;`,
    buildings: `${OVERPASS_PREFIX}wr["building"]${b};out geom;`,
    extra: `${OVERPASS_PREFIX}(${EXTRA.map((f) => `wr${f}${b};`).join("")});out geom;`,
    points: `${OVERPASS_PREFIX}(node["tower:type"="lighting"]${b};node["man_made"~"^(mast|tower|flagpole)$"]${b};);out;`,
    trees: `${OVERPASS_PREFIX}node["natural"="tree"]${b};out;`,
    coastline: `${OVERPASS_PREFIX}way["natural"="coastline"]${b};out geom tags;`,
  };
}

const DROP_HIGHWAY = new Set(["proposed", "construction", "abandoned", "corridor", "platform", "elevator", "bus_stop"]);

/** Integer layer tag, or 0 when missing. An unparseable layer is null so callers can count it. */
export function layerOf(tags) {
  if (tags.layer === undefined) return 0;
  const n = Number(String(tags.layer).split(";")[0].trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** `bridge` present and not "no". */
export const isBridge = (tags) => typeof tags.bridge === "string" && tags.bridge !== "no";

/** Highway filter (spec section 2). → boolean */
export function keepHighway(tags) {
  if (!tags || typeof tags.highway !== "string") return false;
  if (DROP_HIGHWAY.has(tags.highway)) return false;
  if (Object.keys(tags).some((k) => k === "indoor" || k.startsWith("indoor:"))) return false;
  const layer = layerOf(tags);
  if (layer === null || layer < 0) return false;
  if (tags.tunnel === "yes") return false;
  if (tags.area === "yes" && tags.highway !== "pedestrian") return false;
  if (tags.footway === "sidewalk" || tags.footway === "crossing") return false;
  return true;
}

/**
 * Building filter (spec-v2 §3.2): drops underground and zero-level slabs (the Muni/BART station boxes).
 * → null to keep, or the reason string it was dropped for.
 */
export function dropBuildingReason(tags) {
  const layer = layerOf(tags);
  if (layer !== null && layer < 0) return "layer<0";
  if (tags.location === "underground") return "location=underground";
  if (tags["building:levels"] !== undefined && Number(String(tags["building:levels"]).trim()) === 0 && parseHeightM(tags.height) === null) {
    return "building:levels=0 without height";
  }
  return null;
}

const ROAD_CLASSES = Object.freeze({
  motorway: { roadway: 7, sidewalk: 0, surface: SURFACE.ROAD },
  trunk: { roadway: 6, sidewalk: 1, surface: SURFACE.ROAD },
  primary: { roadway: 6, sidewalk: 1, surface: SURFACE.ROAD },
  secondary: { roadway: 5, sidewalk: 1, surface: SURFACE.ROAD },
  tertiary: { roadway: 4, sidewalk: 1, surface: SURFACE.ROAD },
  residential: { roadway: 4, sidewalk: 1, surface: SURFACE.ROAD },
  unclassified: { roadway: 4, sidewalk: 1, surface: SURFACE.ROAD },
  living_street: { roadway: 3, sidewalk: 1, surface: SURFACE.ROAD },
  busway: { roadway: 3, sidewalk: 0, surface: SURFACE.ROAD },
  service: { roadway: 2, sidewalk: 0, surface: SURFACE.ROAD },
  pedestrian: { roadway: 3, sidewalk: 0, surface: SURFACE.PLAZA },
  footway: { roadway: 1, sidewalk: 0, surface: SURFACE.SIDEWALK },
  path: { roadway: 1, sidewalk: 0, surface: SURFACE.SIDEWALK },
  cycleway: { roadway: 1, sidewalk: 0, surface: SURFACE.SIDEWALK },
  steps: { roadway: 1, sidewalk: 0, surface: SURFACE.SIDEWALK },
});
const NAME_OVERRIDES = Object.freeze({
  "Market Street": { roadway: 7, sidewalk: 2 },
  "Van Ness Avenue": { roadway: 8 },
});
/** Classes whose elevated ways (layer ≥ 1 or any bridge length) become decks; other classes only as short bridges. */
export const DECK_CLASSES = new Set(["motorway", "trunk", "primary"]);
/** Any `bridge` way under this length (metres) is a deck, over water too (spec-v2 §3.8). */
export const SHORT_BRIDGE_M = 300;

/** Base class of a highway value: "primary_link" → "primary". */
export const highwayClass = (h) => (h.endsWith("_link") ? h.slice(0, -5) : h);

/** → {roadway, sidewalk, surface} in blocks, or null for classes outside the width table */
export function roadSpec(tags) {
  const h = tags.highway;
  const link = h.endsWith("_link");
  const cls = ROAD_CLASSES[highwayClass(h)];
  if (!cls) return null;
  const spec = { ...cls };
  if (link) spec.roadway = Math.max(2, cls.roadway - 2);
  Object.assign(spec, NAME_OVERRIDES[tags.name] ?? {});
  if (tags.width !== undefined) {
    const w = parseHeightM(tags.width);
    if (w !== null) spec.roadway = Math.max(1, Math.round(w / 3));
  }
  return spec;
}

const PAVED = new Set(["paved", "asphalt", "concrete", "concrete:plates", "paving_stones", "sett", "cobblestone", "unhewn_cobblestone", "bricks", "brick", "stone", "granite"]);
const COURT_SURFACES = new Set(["asphalt", "concrete", "acrylic", "paved"]);
const DIRT_SURFACES = new Set(["dirt", "clay", "earth"]);
const POND_WATER = new Set(["pond", "fountain", "reflecting_pool", "basin"]);

/**
 * Landcover table (spec §2 + spec-v2 §3.7). → SURFACE value, or null (unmapped or skipped, counted in the report).
 * POOL is returned for ponds, fountains, pools and raised (layer ≥ 1) water; the caller stamps it only on mask
 * land, keeping the ground, so the "water iff ground 0" rule holds.
 */
export function landcoverSurface(tags) {
  const { leisure, landuse, natural, amenity, surface } = tags;
  const layer = layerOf(tags);
  if (tags.man_made === "pier") return SURFACE.PIER;
  if (tags.highway === "pedestrian" && tags.area === "yes") return SURFACE.PLAZA;
  if (amenity === "parking") return tags.parking === "underground" || (layer !== null && layer < 0) ? null : SURFACE.PARKING;
  if (landuse === "railway") return SURFACE.RAIL;
  if (amenity === "fountain" || leisure === "swimming_pool") return SURFACE.POOL;
  if (natural === "water") return POND_WATER.has(tags.water) || (layer !== null && layer >= 1) ? SURFACE.POOL : SURFACE.WATER;
  if (natural === "sand" || natural === "beach") return natural === "sand" && (tags.sport === "baseball" || DIRT_SURFACES.has(surface)) ? SURFACE.DIRT : SURFACE.SAND;
  if (landuse === "forest" || natural === "wood" || natural === "scrub") return SURFACE.FOREST;
  if (leisure === "track") return SURFACE.TRACK;
  if (leisure === "pitch") {
    if (surface === "tartan") return SURFACE.TRACK;
    if (COURT_SURFACES.has(surface)) return SURFACE.COURT;
    if (DIRT_SURFACES.has(surface)) return SURFACE.DIRT;
    return SURFACE.GRASS;
  }
  if (leisure === "park" && PAVED.has(surface)) return SURFACE.PLAZA;
  if (leisure === "park" || leisure === "garden" || landuse === "recreation_ground" || landuse === "cemetery") return SURFACE.PARK;
  if (leisure === "golf_course" || leisure === "dog_park" || landuse === "grass" || natural === "grassland") return SURFACE.GRASS;
  return null;
}

/** Why landcoverSurface skipped a tagged feature on purpose (not just unmapped), or null. */
export function landcoverSkipReason(tags) {
  if (tags.amenity === "parking" && landcoverSurface(tags) === null) return "underground parking";
  return null;
}

const FT_M = 0.3048;
const IN_M = 0.0254;

/** Parse m or ft ("12", "12 m", "40'", "40 ft", "12'6\"", "12,5"). → metres, or null if unparseable */
export function parseHeightM(value) {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase().replace(/(\d),(\d)/g, "$1.$2");
  let m;
  if ((m = /^(\d+(?:\.\d+)?)\s*(?:m|meters?|metres?)?$/.exec(s))) return pos(Number(m[1]));
  if ((m = /^(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)$/.exec(s))) return pos(Number(m[1]) * FT_M);
  if ((m = /^(\d+(?:\.\d+)?)\s*(?:'|ft)\s*(\d+(?:\.\d+)?)\s*(?:"|''|in)$/.exec(s))) return pos(Number(m[1]) * FT_M + Number(m[2]) * IN_M);
  return null;
}
const pos = (v) => (Number.isFinite(v) && v > 0 ? v : null);

const levelCount = (value) => {
  if (value === undefined) return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** building:levels → metres at 3.5 m per level, or null. */
export function levelsHeightM(value) {
  const n = levelCount(value);
  return n !== null && n > 0 ? n * 3.5 : null;
}

export const OFFICE_LEVEL_M = 4;
export const OFFICE_LEVELS_MIN = 10;
const isOffice = (tags) => tags["building:part"] === "office" || tags.building === "office" || tags.office !== undefined;

/**
 * Height of an OSM building or part (spec-v2 §3.4 rule 5): `height`, else levels × 3.5 m, or 4 m per level for
 * office buildings/parts with ≥ 10 levels. → metres, or null when untagged or unparseable.
 */
export function osmHeightM(tags) {
  if (tags.height !== undefined) return parseHeightM(tags.height);
  const n = levelCount(tags["building:levels"]);
  if (n === null || n === 0) return null;
  return n * (isOffice(tags) && n >= OFFICE_LEVELS_MIN ? OFFICE_LEVEL_M : 3.5);
}

/** `min_height`, else building:min_level × 3.5 m. → metres, or null when neither is tagged/parseable. */
export function osmMinHeightM(tags) {
  if (tags.min_height !== undefined) {
    const v = String(tags.min_height).trim();
    if (v === "0") return 0;
    return parseHeightM(v);
  }
  const n = levelCount(tags["building:min_level"]);
  return n === null ? null : n * 3.5;
}
