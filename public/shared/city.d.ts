export declare const CITY_VERSION: 2;
export declare const BLOCK_M: 3;
export declare const CHUNK: 64;
export declare const REGION: 4;
export declare const OFFICE_CELL_BLOCKS: 0.25;

// ---------- projection ----------

export interface Projection {
  lon0: number;
  lat0: number;
  latRef: number;
  mPerDegLat: number;
  mPerDegLon: number;
  /** rigid rotation of the v1 equirect about (pivotX, pivotZ), degrees */
  rotDeg: number;
  pivotX: number;
  pivotZ: number;
  /** shift after rotation; multiples of CHUNK */
  x0: number;
  z0: number;
}
export interface LonLatBox { west: number; south: number; east: number; north: number }
export declare const ROT_DEG: 44.7;
export declare const SF_PIVOT: Readonly<{ lon: number; lat: number }>;
export declare const SF_BOX: Readonly<LonLatBox>;
export declare const SF_MARGIN: 64;
export declare const SF_PROJ: Readonly<Projection>;
export declare const SF_GRID: readonly [gx: number, gz: number];
export declare const PROJ_KEYS: readonly (keyof Projection)[];
export declare function lonLatToBlock(lon: number, lat: number, proj?: Projection): { x: number; z: number };
export declare function blockToLonLat(x: number, z: number, proj?: Projection): { lon: number; lat: number };
export declare function fitProjection(
  base: Pick<Projection, "lon0" | "lat0" | "latRef" | "mPerDegLat" | "mPerDegLon">,
  rotDeg: number,
  pivot: { lon: number; lat: number },
  box: LonLatBox,
  margin: number,
): { proj: Projection; grid: [gx: number, gz: number] };
export declare function validateProj(p: unknown, what?: string): Projection;
export declare function chunkOf(x: number, z: number): [cx: number, cz: number];
export declare function chunkKey(cx: number, cz: number): string;
export declare function regionOf(cx: number, cz: number): [rx: number, rz: number];

// ---------- surfaces & palette ----------

export declare const SURFACE: Readonly<{
  WATER: 1; SHALLOW: 2; SAND: 3; GRASS: 4; PARK: 5; FOREST: 6; ROAD: 7; SIDEWALK: 8; RAIL: 9; PLAZA: 10;
  PIER: 11; HILL: 12; PARKING: 13; DIRT: 14; COURT: 15; TRACK: 16; POOL: 17;
}>;
export type Surface = (typeof SURFACE)[keyof typeof SURFACE];
export declare const SURFACE_COLORS: Readonly<Record<Surface, string>>;
export declare const TERRAIN_SIDE_COLORS: Readonly<Record<Surface, string>>;
export declare const UNBUILT_COLORS: Readonly<{ top: string; side: string }>;
export declare const DECK_COLORS: Readonly<{ top: string; edge: string; pillar: string; under: string }>;

export declare const BUILDING_PALETTE: readonly string[];
export declare const PALETTE_INDEX: Readonly<Record<string, number>>;
export interface PaletteGroup { minH: number; maxH: number; indices: readonly number[] }
export declare const PALETTE_GROUPS: Readonly<{ pastel: PaletteGroup; midrise: PaletteGroup; stone: PaletteGroup; tall: PaletteGroup; glass: PaletteGroup }>;
export declare const ROOF_DARKEN: number;
export declare const CAP: Readonly<{ FLAT: 0; CROWN: 1; SPIRE: 2; DOME: 3; GREEN: 4; SEATS: 5 }>;
export declare const FACADE: Readonly<{ WINDOWS: 0; BLANK: 1; RIBBED: 2; PARKING: 3; ARCADE: 4; CURTAIN: 5 }>;
export declare const ACCENT_NONE: 0x7fff;
export type StructureKind =
  | "ballpark" | "arena" | "conference" | "pier_shed" | "terminal_tower" | "church" | "parking_garage" | "canopy" | "transit_roofpark";
export declare const STRUCTURE_KINDS: readonly StructureKind[];
export declare const MATERIAL_COLORS: Readonly<Record<string, string>>;
export declare function osmColourToHex(tag: unknown): string | null;
export declare function osmMaterial(tag: unknown): string | null;
export declare function nearestPaletteIndex(hex: string): number;
export declare function hashId(id: number): number;
export interface PaletteOptions { colour?: string; material?: string; structure?: StructureKind }
export declare function paletteFor(heightBlocks: number, id: number, opts?: PaletteOptions): number;

// ---------- chunk (SFC1 v2) ----------

export declare const CHUNK_MAGIC: "SFC1";
export declare const COLUMNS: 4096;
export declare const HEADER_BYTES: 16;
export declare const BUILDING_ENTRY_BYTES: 20;
export declare const PROP_BYTES: 8;
export declare const CHUNK_BODY_BYTES: number;
export declare const MAX_CAP: 5;
export declare const MAX_FACADE: 5;
export declare const MAX_CHUNK_GZ_BYTES: number;
export declare const CITY_BUDGET: Readonly<{ files: number; totalBytes: number; chunkGzBytes: number }>;
export declare const TERRAIN_EXAGGERATION: Readonly<{ default: 1; min: 1; max: 3 }>;

export interface BuildingEntry {
  /** u32 ≥ 1, unique within one build. */
  id: number;
  /** 0 = none, else a building id in the same chunk table or a key of manifest.parents. pick resolves to parent || id. */
  parent: number;
  /** min ground under the footprint; every column of this entry has ground == base. */
  base: number;
  /** max column top of this entry within this chunk (> base). */
  top: number;
  /** side faces at y ≥ accentFrom use `accent`; ACCENT_NONE = no band. */
  accentFrom: number;
  /** index into BUILDING_PALETTE. */
  palette: number;
  /** CAP value; the column top face only. */
  cap: number;
  /** FACADE value. */
  facade: number;
  /** palette index for cap faces and the accent band. */
  accent: number;
}

export interface ChunkProp {
  /** chunk-local column */
  lx: number;
  lz: number;
  y0: number;
  y1: number;
  /** palette index */
  color: number;
  /** 1 = emissive */
  flags: number;
}

export interface Chunk {
  cx: number;
  cz: number;
  /** always 0 (grid option a; c1 would add frames) */
  frame: 0;
  /** column index = lz * 64 + lx. Water iff 0; land ≥ 1. */
  ground: Int16Array;
  surface: Uint8Array;
  /** 0 = none, else building table index + 1. */
  bldg: Uint16Array;
  /** 0 = none, > 0 slab top y, < 0 slab top −deck plus a pillar to the ground. */
  deck: Int16Array;
  /** per-column building top; > base iff bldg ≠ 0, else 0. */
  top: Int16Array;
  buildings: BuildingEntry[];
  props: ChunkProp[];
}
/** manifest.parents: {"<id>": name} for multi-entry landmarks. */
export type Parents = Record<string, string>;

export declare function isGzip(bytes: Uint8Array): boolean;
export declare function assertGzip(bytes: Uint8Array, what?: string): void;
export declare function validateChunk(chunk: Chunk, parents?: Parents): Chunk;
export declare function chunkByteLength(nBuildings: number, nProps: number): number;
/** Raw SFC1 bytes; gzip them before writing `chunks/{cx}_{cz}.bin`. */
export declare function encodeChunk(chunk: Chunk, parents?: Parents): Uint8Array;
/** Inflated SFC1 bytes → chunk; throws on HTML, gzip, bad magic/version or bad data. Pass manifest.parents. */
export declare function decodeChunk(bytes: Uint8Array, parents?: Parents): Chunk;
export declare function pickId(entry: Pick<BuildingEntry, "id" | "parent">): number;

// ---------- landmarks.bin (SFL1) ----------

export declare const LANDMARKS_MAGIC: "SFL1";
export declare const LANDMARKS_VERSION: 1;
export declare const LANDMARKS_HEADER_BYTES: 12;
export declare const LANDMARK_BOX_BYTES: 12;
export declare const MAX_LANDMARKS_BYTES: number;
export interface LandmarkBox { x: number; z: number; y0: number; y1: number; sx: number; sz: number; color: number; flags: number }
export declare function validateLandmarks(boxes: LandmarkBox[], grid?: readonly [number, number]): LandmarkBox[];
export declare function encodeLandmarks(boxes: LandmarkBox[], grid?: readonly [number, number]): Uint8Array;
export declare function decodeLandmarks(bytes: Uint8Array, grid?: readonly [number, number]): LandmarkBox[];

// ---------- landmask.bin (SFM1) ----------

export declare const LANDMASK_MAGIC: "SFM1";
export declare const LANDMASK_VERSION: 1;
export declare const LANDMASK_HEADER_BYTES: 10;
export declare const LANDMASK_CELL: 4;
/** cells[cz * cellsX + cx]: 0 = sea, 1–255 = land with coarse ground height + 1. */
export interface Landmask { cellsX: number; cellsZ: number; cells: Uint8Array }
export declare function validateLandmask(mask: Landmask, grid?: readonly [number, number]): Landmask;
export declare function encodeLandmask(mask: Landmask, grid?: readonly [number, number]): Uint8Array;
export declare function decodeLandmask(bytes: Uint8Array, grid?: readonly [number, number]): Landmask;
export declare function landmaskHeight(mask: Landmask, x: number, z: number): number | null;

// ---------- walk.bin (SFW1) ----------

export declare const WALK_MAGIC: "SFW1";
export declare const WALK_VERSION: 1;
export declare const WALK_HEADER_BYTES: 32;
export declare const WALK_NODE_INTS: 3;
export declare const WALK_EDGE_INTS: 5;
export declare const MAX_WALK_BYTES: number;
export declare const WALK_Y_MAX: 300;
export declare const WALK_NO_NAME: -1;
export interface WalkGraph {
  /** epoch ms; equals Date.parse(manifest.builtAt) */
  builtAt: number;
  /** [x10, z10, y10] per node, decimetre-blocks; y is the walking surface (ground or deck top) */
  nodes: Int32Array;
  /** [a, b, len10, nameIdx (−1 = unnamed), halfWidth10 | deck << 31] per edge; every edge in both directions */
  edges: Int32Array;
  names: string[];
}
export declare function edgeHalfWidth10(edges: Int32Array, e: number): number;
export declare function edgeIsDeck(edges: Int32Array, e: number): boolean;
export declare function packEdgeWidth(halfWidth10: number, deck: boolean): number;
export declare function validateWalk(g: WalkGraph, manifest?: Manifest): WalkGraph;
export declare function encodeWalk(g: WalkGraph, manifest?: Manifest): Uint8Array;
export declare function decodeWalk(bytes: Uint8Array, manifest?: Manifest): WalkGraph;

// ---------- places.json ----------

export type PlaceKind = "company" | "landmark" | "intersection" | "area";
export declare const PLACE_KINDS: readonly PlaceKind[];
export interface Place {
  id: string;
  kind: PlaceKind;
  name: string;
  aliases: string[];
  lat: number;
  lon: number;
  x: number;
  z: number;
  /** walk graph node index */
  node: number;
  /** company places only */
  siteId?: string;
  /** company places: door column [x, z] */
  door?: [number, number];
}
export interface PlacesDoc { builtAt: string; places: Place[] }
export declare function intersectionName(a: string, b: string): string;
export declare function validatePlaces(doc: unknown, manifest: Manifest, walk: WalkGraph): PlacesDoc;

// ---------- manifest ----------

export interface ManifestSource { id: string; url: string; license: string; [k: string]: unknown }
export interface ManifestArea extends LonLatBox { id: string }
export interface Manifest {
  version: 2;
  city: string;
  name: string;
  blockM: 3;
  chunk: 64;
  proj: Projection;
  /** vertical scale applied to terrain at build time (1 = real) */
  terrainExaggeration: number;
  /**
   * grid: reserved chunks per axis (cx, cz ∈ [0, grid)); min/max: the shipped range; list: shipped chunks.
   * A chunk that is neither listed nor in `water` is drawn from landmask.bin (unbuilt land or sea).
   */
  chunks: { grid: [number, number]; min: [number, number]; max: [number, number]; list: [cx: number, cz: number, bytesGz: number][] };
  /** in-area chunks that are entirely water: not shipped, drawn as sea */
  water: [cx: number, cz: number][];
  areas: ManifestArea[];
  /** file names next to the manifest: landmask/landmarks gzipped, walk raw, places JSON */
  landmask: string;
  landmarks: string;
  walk: string;
  places: string;
  parents: Parents;
  yRange: [number, number];
  /** az: camera azimuth (radians) at spawn */
  spawn: { x: number; z: number; dist: number; az: number };
  attribution: string[];
  sources: ManifestSource[];
  builtAt: string;
}
export declare function validateManifest(m: unknown): Manifest;

// ---------- companies ----------

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
export interface Companies { version: 2; city: string; builtAt: string; sites: CompanySite[] }
export declare function validateCompanies(doc: unknown, manifest?: Manifest): Companies;
