// SF build constants (docs/city/spec.md §1-2, §5, extended by docs/city/spec-v2.md §1-3): the areas, their
// fetch boxes, the land/water mask dataset, the terrain knob and the verify-sf known points.
import { CITY_BUDGET, ROT_DEG, SF_GRID, SF_PROJ, TERRAIN_EXAGGERATION as TX_RANGE } from "../../../public/shared/city.js";

export const CITY = "sf";
export const NAME = "San Francisco";
export const PROJ = SF_PROJ;
export const GRID = SF_GRID;

/**
 * Built areas (spec-v2 §2), lon/lat boxes. A chunk ships when one of its 8×8 samples lies in an area (and the
 * chunk is not all open water). `fetch` is the area plus a ~500 m margin; east keeps the v1 FETCH_BBOX exactly
 * so its cached Overpass/DataSF requests stay byte-identical. Lincoln Park (about −122.50) is outside west.
 */
export const AREAS = Object.freeze([
  Object.freeze({
    id: "east", west: -122.42836, south: 37.75513, east: -122.38254, north: 37.81069,
    fetch: Object.freeze({ south: 37.7501, west: -122.434, north: 37.8157, east: -122.3769 }),
  }),
  Object.freeze({
    id: "west", west: -122.4860, south: 37.7840, east: -122.4284, north: 37.8125,
    fetch: Object.freeze({ south: 37.779, west: -122.4916, north: 37.8175, east: -122.4228 }),
  }),
]);

/** Raw-cache source id of one fetch kind for one area. East keeps the v1 ids so its cache carries over. */
export const areaSourceId = (kind, area) => (area.id === "east" ? kind : `${kind}-${area.id}`);
/** Raw-cache file of one fetch kind for one area, relative to RAW_DIR. */
export const areaSourceFile = (dir, kind, area, ext) => `${dir}/${areaSourceId(kind, area)}.${ext}`;

/**
 * Ground elevation scale (spec-v2 operator decision): 1.0 = real 1:1 relief. The operator may ask for 1.5–2×;
 * set CITY_TERRAIN_EXAGGERATION for one build. Building heights never scale. Recorded in manifest.terrainExaggeration.
 */
export const TERRAIN_EXAGGERATION = parseExaggeration(process.env.CITY_TERRAIN_EXAGGERATION);
function parseExaggeration(v) {
  if (v === undefined || v === "") return TX_RANGE.default;
  const n = Number(v);
  if (!Number.isFinite(n) || n < TX_RANGE.min || n > TX_RANGE.max) {
    throw new Error(`CITY_TERRAIN_EXAGGERATION=${v}: must be a number in ${TX_RANGE.min}..${TX_RANGE.max}`);
  }
  return n;
}

/**
 * Hill shading data: natural ground (no road, park or other cover) reads as HILL rather than GRASS when it is
 * this high, or when the local slope over HILL_SLOPE_RADIUS blocks reaches HILL_SLOPE (rise/run, blocks).
 */
export const HILL_GROUND = 20;
export const HILL_SLOPE = 0.35;
export const HILL_SLOPE_RADIUS = 3;

/**
 * Spawn: the v1 view (centre between Salesforce Tower and Transamerica, 900 blocks out, camera from the SSE at
 * three.js azimuth 0.18π on a north-up map). The azimuth is rotated with the grid so the compass view is kept.
 */
export const SPAWN = Object.freeze({ lon: -122.4, lat: 37.79213, dist: 900, azNorthUp: Math.PI * 0.18 });
export const spawnAz = () => SPAWN.azNorthUp - (ROT_DEG * Math.PI) / 180;
/** Marin Headlands (unbuilt landmask land only): north of the strait's midline, west of Alcatraz, terrain above minM. */
export const MARIN = Object.freeze({ south: 37.8185, east: -122.44, minM: 3 });
/** SoMa / Showplace Square, lon/lat ring: large low untagged footprints here may get the warehouse brick share. */
export const SOMA_WAREHOUSES = Object.freeze([
  [-122.4195, 37.7735], [-122.3945, 37.7935], [-122.3880, 37.7890], [-122.3870, 37.7650], [-122.4060, 37.7630], [-122.4140, 37.7670],
]);
/** Exists but stays off (spec §1: vertical is linear 1:1). */
export const TOWER_KNEE = null;

export const RAW_DIR = "data/city/sf/raw";
export const BUILD_DIR = "data/city/sf/build";
export const OUT_DIR = "public/city/sf";
/** Merged building records for W3 (spec-v2 §8 day-2 deliverable; gitignored). */
export const CACHE_BUILDINGS = "scripts/city/.cache/sf-buildings.json";

const datasfBox = (b) => `${b.north.toFixed(4)},${b.west.toFixed(4)},${b.south.toFixed(4)},${b.east.toFixed(4)}`;
export const ENDPOINTS = Object.freeze({
  datasfFootprints: (fetchBox) =>
    `https://data.sf.gov/resource/ynuv-fyni.geojson?$select=area_id,mblr,hgt_median_m,hgt_maxcm,gnd_min_m,peak_1st_m,shape&$where=within_box(shape,${datasfBox(fetchBox)})&$limit=200000`,
  overpass: "https://overpass-api.de/api/interpreter",
  terrarium: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
  joerdAttribution: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
  // GitHub contents API: application/json carrying the verbatim attribution.md (github.com itself serves HTML)
  joerdAttributionApi: "https://api.github.com/repos/tilezen/joerd/contents/docs/attribution.md?ref=master",
});

/** Fine terrain zoom (built chunks) and coarse zoom (landmask relief over the whole reserved grid). */
export const TERRAIN_ZOOM = 15;
export const COARSE_TERRAIN_ZOOM = 12;
/** The whole-city box the coarse z12 terrain covers (the reserved grid is fitted to it). */
export const COARSE_TERRAIN_BOX = Object.freeze({ south: 37.708, west: -122.52, north: 37.845, east: -122.3569 });

/**
 * Land/water mask, pinned by W2: DataSF "Analysis Neighborhoods" (j2bu-swwd, PDDL). Its 41 neighbourhood
 * polygons are 2010 census tracts clipped to the shoreline, so their union is the city's land; everything
 * outside them is water. Checked: Pier 39, Ferry Building, Piers 48 and 70 are land; McCovey Cove and the
 * Bay east of the Embarcadero are water. Smaller piers are restored by OSM man_made=pier and building rules.
 */
export const MASK = Object.freeze({
  id: "datasf-land",
  dataset: "j2bu-swwd",
  url: "https://data.sf.gov/resource/j2bu-swwd.geojson?$limit=1000",
  license: "PDDL-1.0",
});

export const LICENSES = Object.freeze({ datasf: "PDDL-1.0", osm: "ODbL-1.0", terrain: "Terrain Tiles on AWS Open Data; per-source terms in the joerd attribution" });
export const OVERPASS_COOLDOWN_H = 24;

export const ATTRIBUTION =
  "Map data © OpenStreetMap contributors, ODbL — openstreetmap.org/copyright · Building footprints & addresses: DataSF, City and County of San Francisco (PDDL) · Elevation: Terrain Tiles on AWS Open Data (Mapzen/Tilezen; sources incl. USGS 3DEP, NOAA — github.com/tilezen/joerd/blob/master/docs/attribution.md) · Company locations: public sources listed per entry.";

export const BUDGET = Object.freeze({
  chunkBytes: CITY_BUDGET.chunkGzBytes, totalBytes: CITY_BUDGET.totalBytes, files: CITY_BUDGET.files,
  manifestBytes: 100 * 1024, companiesBytes: 64 * 1024, landmaskBytes: 256 * 1024,
});

/** OSM ways that are never buildings or chunk decks: the Bay Bridge towers and decks come from landmarks.bin (W3);
 * the Oracle Park stadium relation (r7330762) is drawn by the lm:oracle-park ballpark recipe. */
export const DROP_BUILDINGS = Object.freeze(["o:w432712476", "o:w432712477", "o:r7330762"]);
/** Deck ways whose name/bridge:name matches are drawn by the landmark mesh, never as chunk decks. */
export const LANDMARK_BRIDGE_RE = /Bay Bridge|Golden Gate Bridge/i;

/**
 * verify-sf known points (lat/lon). Mission Creek, McCovey Cove and the Embarcadero points are pinned from the
 * cached OSM data: Mission Creek mid-channel inside natural=water way 579720319; McCovey Cove open water between
 * the ballpark and McCovey Point; the Embarcadero on the centreline of primary way 283512618 in front of the
 * Ferry Building. Salesforce and Transamerica points are inside OSM ways 431972186 and 24222973.
 * v2 points (spec-v2 §2, §8 W2) are listed with the source of each coordinate.
 */
export const VERIFY = Object.freeze({
  ferryBuilding: { lat: 37.7955, lon: -122.3937 },
  graceCathedral: { lat: 37.7919, lon: -122.4134 },
  coitTower: { lat: 37.8024, lon: -122.4058 },
  salesforceTower: { lat: 37.7897744, lon: -122.3969321 },
  transamerica: { lat: 37.7952, lon: -122.4028 },
  openai1455: { lat: 37.770045, lon: -122.388788 },
  pier39: { lat: 37.8087, lon: -122.4098 },
  missionCreek: { lat: 37.7731, lon: -122.3950 },
  mccoveyCove: { lat: 37.7777, lon: -122.3885 },
  embarcadero: { lat: 37.79502, lon: -122.39435 },
  bayEast: { lat: 37.7950, lon: -122.3850 },
  // spec-v2 §2 Presidio points. Fort Point and the GGB south tower: the spec's Wikipedia coordinates; lagoon = vertex
  // mean of natural=water relation 7471537; Crissy beach = a point inside natural=beach way 934489949 (its vertex mean falls in the water); Main Post = the Main Parade lawn
  fortPoint: { lat: 37.81056, lon: -122.47722 },
  ggbSouthTower: { lat: 37.814014, lon: -122.477891 }, // OSM south tower building:part centroid; the spec-v2 §5 coordinate is ~300 m south, on land
  palaceLagoon: { lat: 37.80303, lon: -122.44775 },
  crissyBeach: { lat: 37.80552, lon: -122.4579 },
  presidioMainPost: { lat: 37.80005, lon: -122.45744 },
  // spec-v2 §8 W2 points: Civic Center station = vertex mean of the dropped OSM station way 775660875 (layer -1,
  // building:levels 0); 4th St bridge = mid of way 160313264 (bridge=movable over Mission Creek); YBG fountain =
  // Martin Luther King Jr. fountain way 25298444 (natural=water, layer 2); Union Square = park way 25278818
  civicCenterStation: { lat: 37.77939, lon: -122.41408 },
  fourthStBridge: { lat: 37.77503, lon: -122.39238 },
  ybgFountain: { lat: 37.78455, lon: -122.40217 },
  unionSquare: { lat: 37.78794, lon: -122.40755 },
});
