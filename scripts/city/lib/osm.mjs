// Overpass queries and OSM tag → city class rules (spec section 2).
import { SURFACE } from "../../../public/shared/city.js";

export const OVERPASS_PREFIX = "[out:json][timeout:300][maxsize:1073741824];";

/**
 * → {roads, land, buildings, coastline} query strings, each prefixed [out:json][timeout:300][maxsize:1073741824];
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

const ROAD_CLASSES = Object.freeze({
  motorway: { roadway: 7, sidewalk: 0, surface: SURFACE.ROAD },
  trunk: { roadway: 6, sidewalk: 1, surface: SURFACE.ROAD },
  primary: { roadway: 6, sidewalk: 1, surface: SURFACE.ROAD },
  secondary: { roadway: 5, sidewalk: 1, surface: SURFACE.ROAD },
  tertiary: { roadway: 4, sidewalk: 1, surface: SURFACE.ROAD },
  residential: { roadway: 4, sidewalk: 1, surface: SURFACE.ROAD },
  unclassified: { roadway: 4, sidewalk: 1, surface: SURFACE.ROAD },
  living_street: { roadway: 3, sidewalk: 1, surface: SURFACE.ROAD },
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
/** Classes whose bridges/elevated ways become decks. */
export const DECK_CLASSES = new Set(["motorway", "trunk", "primary"]);

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

/** Landcover table (spec section 2). → SURFACE value or null (unmapped, counted in the report) */
export function landcoverSurface(tags) {
  const { leisure, landuse, natural, amenity } = tags;
  if (tags.man_made === "pier") return SURFACE.PIER;
  if (tags.highway === "pedestrian" && tags.area === "yes") return SURFACE.PLAZA;
  if (amenity === "parking") return SURFACE.PARKING;
  if (landuse === "railway") return SURFACE.RAIL;
  if (natural === "water") return SURFACE.WATER;
  if (natural === "sand" || natural === "beach") return SURFACE.SAND;
  if (landuse === "forest" || natural === "wood" || natural === "scrub") return SURFACE.FOREST;
  if (leisure === "park" || leisure === "garden" || landuse === "recreation_ground" || landuse === "cemetery") return SURFACE.PARK;
  if (leisure === "pitch" || leisure === "golf_course" || landuse === "grass" || natural === "grassland") return SURFACE.GRASS;
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

/** building:levels → metres at 3.5 m per level, or null. */
export function levelsHeightM(value) {
  if (value === undefined) return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) && n > 0 ? n * 3.5 : null;
}
