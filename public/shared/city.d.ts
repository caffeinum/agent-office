export declare const CITY_VERSION: 1;
export declare const BLOCK_M: 3;
export declare const CHUNK: 64;
export declare const REGION: 4;
export declare const OFFICE_CELL_BLOCKS: 0.25;
export declare const CHUNK_MAGIC: "SFC1";
export declare const COLUMNS: 4096;
export declare const HEADER_BYTES: 16;
export declare const BUILDING_ENTRY_BYTES: 12;
export declare const MAX_CHUNK_GZ_BYTES: number;
export declare const ROOF_DARKEN: number;

export interface Projection {
  lon0: number;
  lat0: number;
  latRef: number;
  mPerDegLat: number;
  mPerDegLon: number;
}
export declare const SF_PROJ: Readonly<Projection>;

export declare const SURFACE: Readonly<{
  WATER: 1; SHALLOW: 2; SAND: 3; GRASS: 4; PARK: 5; FOREST: 6; ROAD: 7;
  SIDEWALK: 8; RAIL: 9; PLAZA: 10; PIER: 11; HILL: 12; PARKING: 13;
}>;
export type Surface = (typeof SURFACE)[keyof typeof SURFACE];
export declare const SURFACE_COLORS: Readonly<Record<Surface, string>>;

export declare const BUILDING_PALETTE: readonly string[];
export interface PaletteGroup { minH: number; maxH: number; indices: readonly number[] }
export declare const PALETTE_GROUPS: Readonly<{
  pastel: PaletteGroup;
  midrise: PaletteGroup;
  stone: PaletteGroup;
  glass: PaletteGroup;
  landmark: Readonly<{ salesforce: number; transamerica: number }>;
}>;
export declare const TERRAIN_SIDE_COLORS: Readonly<Record<Surface, string>>;
export declare const DECK_COLORS: Readonly<{ top: string; edge: string; pillar: string; under: string }>;
export declare function hashId(id: number): number;
export declare function paletteFor(heightBlocks: number, id: number): number;

export declare function lonLatToBlock(lon: number, lat: number, proj?: Projection): { x: number; z: number };
export declare function blockToLonLat(x: number, z: number, proj?: Projection): { lon: number; lat: number };
export declare function chunkOf(x: number, z: number): [cx: number, cz: number];
export declare function chunkKey(cx: number, cz: number): string;
export declare function regionOf(cx: number, cz: number): [rx: number, rz: number];

export interface BuildingEntry {
  /** u32, unique within one build. */
  id: number;
  /** min ground under the footprint; every column of this building has ground == base. */
  base: number;
  /** roof top y (> base). */
  top: number;
  /** index into BUILDING_PALETTE. */
  palette: number;
  /** 0 = flat (only value in v1). */
  roof: number;
}

export interface Chunk {
  cx: number;
  cz: number;
  /** column index = lz * 64 + lx. Water iff 0; land ≥ 1. */
  ground: Int16Array;
  surface: Uint8Array;
  /** 0 = none, else building table index + 1. */
  bldg: Uint16Array;
  /** 0 = none, > 0 slab top y, < 0 slab top −deck plus a pillar to the ground. */
  deck: Int16Array;
  buildings: BuildingEntry[];
}

export declare function isGzip(bytes: Uint8Array): boolean;
export declare function assertGzip(bytes: Uint8Array, what?: string): void;
export declare function validateChunk(chunk: Chunk): Chunk;
/** Raw SFC1 bytes; gzip them before writing `chunks/{cx}_{cz}.bin`. */
export declare function encodeChunk(chunk: Chunk): Uint8Array;
/** Inflated SFC1 bytes → chunk; throws on HTML, gzip, bad magic/version or bad data. */
export declare function decodeChunk(bytes: Uint8Array): Chunk;

export interface ManifestSource { id: string; url: string; license: string; [k: string]: unknown }
export interface Manifest {
  version: 1;
  city: string;
  name: string;
  blockM: 3;
  chunk: 64;
  proj: Projection;
  /** a chunk inside min/max but not in list is open water. */
  chunks: { min: [number, number]; max: [number, number]; list: [cx: number, cz: number, bytesGz: number][] };
  yRange: [number, number];
  spawn: { x: number; z: number; dist: number };
  attribution: string[];
  sources: ManifestSource[];
  builtAt: string;
}
export declare function validateManifest(m: unknown): Manifest;

export type CompanyStatus = "hq" | "office" | "former" | "landmark";
export type SourceKind = "occupancy" | "registry" | "news" | "company" | "operator";
export type Placement = "contains" | "nearest" | "override";
export declare const COMPANY_STATUSES: readonly CompanyStatus[];
export declare const SOURCE_KINDS: readonly SourceKind[];
export declare const PLACEMENTS: readonly Placement[];

/** date = when the source was published; accessed = when we read it (undated live pages). Rule 8 compares `date` only. */
export type CompanySource =
  | { url: string; kind: Exclude<SourceKind, "operator">; date?: string; accessed?: string }
  /** the operator's own statement, with no URL to cite */
  | { kind: "operator"; statement: string; date: string };
export interface CompanySite {
  id: string;
  companyId: string;
  name: string;
  primary: boolean;
  address: string;
  status: CompanyStatus;
  category: string;
  color: string;
  sources: CompanySource[];
  verifiedAt: string;
  note?: string;
  lat: number;
  lon: number;
  eas: { id: number; parcel: string };
  hintFrom: string;
  buildingId: number;
  block: { x: number; z: number };
  chunk: [number, number];
  anchor: { x: number; y: number; z: number };
  roofY: number;
  heightM: number;
  placement: Placement;
  placementDistM: number;
}
export interface Companies { version: 1; city: string; builtAt: string; sites: CompanySite[] }
export declare function validateCompanies(doc: unknown, manifest?: Manifest): Companies;
