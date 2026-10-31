// STUB (W1) — owner W2. SF build constants. Values below are copied from docs/city/spec.md;
// W2 adds its pinned values (mask dataset id/URL, verify points for Mission Creek, McCovey Cove,
// Embarcadero) here before coding against them.
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
export const SPAWN = Object.freeze({ x: 3610, z: 1667, dist: 600 });
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
});

export const ATTRIBUTION =
  "Map data © OpenStreetMap contributors, ODbL — openstreetmap.org/copyright · Building footprints & addresses: DataSF, City and County of San Francisco (PDDL) · Elevation: Terrain Tiles on AWS Open Data (Mapzen/Tilezen; sources incl. USGS 3DEP, NOAA — github.com/tilezen/joerd/blob/master/docs/attribution.md) · Company locations: public sources listed per entry.";

export const BUDGET = Object.freeze({ chunkBytes: 64 * 1024, totalBytes: 8 * 1024 * 1024, files: 700, manifestBytes: 100 * 1024, companiesBytes: 50 * 1024 });
