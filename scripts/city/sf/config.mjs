// SF build constants (docs/city/spec.md sections 1-2, 5) plus the values W2 pinned: the land/water mask
// dataset and the verify-sf known points.
import { SF_PROJ } from "../../../public/shared/city.js";

export const CITY = "sf";
export const NAME = "San Francisco";
export const PROJ = SF_PROJ;
/** v1 chunk range, inclusive. */
export const CHUNK_MIN = Object.freeze([42, 14]);
export const CHUNK_MAX = Object.freeze([62, 46]);
/** v1 bbox in degrees. */
export const BBOX = Object.freeze({ south: 37.75513, west: -122.42836, north: 37.81069, east: -122.38254 });
/** Fetch bbox = v1 bbox + 500 m margin. */
export const FETCH_BBOX = Object.freeze({ south: 37.7501, west: -122.434, north: 37.8157, east: -122.3769 });
/**
 * Spawn frames the whole FiDi skyline (Salesforce Tower to Transamerica, the 15 tallest tops) with headroom for
 * their label chips at both 1280x800 and 390x844, at the scene's fixed spawn tilt (polar 0.95, from the SE).
 */
export const SPAWN = Object.freeze({ x: 3520, z: 1580, dist: 900 });
/** Exists but stays off (spec §1: vertical is linear 1:1). */
export const TOWER_KNEE = null;

export const RAW_DIR = "data/city/sf/raw";
export const BUILD_DIR = "data/city/sf/build";
export const OUT_DIR = "public/city/sf";

export const ENDPOINTS = Object.freeze({
  datasfFootprints:
    "https://data.sf.gov/resource/ynuv-fyni.geojson?$select=area_id,mblr,hgt_median_m,hgt_maxcm,gnd_min_m,peak_1st_m,shape&$where=within_box(shape,37.8157,-122.4340,37.7501,-122.3769)&$limit=200000",
  overpass: "https://overpass-api.de/api/interpreter",
  terrarium: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/{x}/{y}.png",
  joerdAttribution: "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
  // GitHub contents API: application/json carrying the verbatim attribution.md (github.com itself serves HTML)
  joerdAttributionApi: "https://api.github.com/repos/tilezen/joerd/contents/docs/attribution.md?ref=master",
});

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

export const BUDGET = Object.freeze({ chunkBytes: 64 * 1024, totalBytes: 8 * 1024 * 1024, files: 700, manifestBytes: 100 * 1024, companiesBytes: 50 * 1024 });

/**
 * verify-sf known points (lat/lon). Mission Creek, McCovey Cove and the Embarcadero points are pinned from the
 * cached OSM data: Mission Creek mid-channel inside natural=water way 579720319; McCovey Cove open water between
 * the ballpark and McCovey Point; the Embarcadero on the centreline of primary way 283512618 in front of the
 * Ferry Building. Salesforce and Transamerica points are inside OSM ways 431972186 and 24222973.
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
});
