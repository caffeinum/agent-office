import type { Activity, CustomKinds, Grid, Item, Layer, Rot, Seat, Station } from "./catalog.js";
import type { Theme } from "./theme.js";

export type BoxMaterial = "matte" | "glossy" | "glass" | "screen";

/** One voxel box in local model space (16 units per cell); integer units, inside the footprint, y + h ≤ 64. */
export interface Box {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
  emissive?: true;
  /** Omitted = matte. "screen" boxes show the office logo when the kind has screen: true. */
  material?: Exclude<BoxMaterial, "matte">;
}

/** What agents send to office_define_kind. */
export interface KindDef {
  kind: string;
  label: string;
  footprint: { w: number; d: number };
  layer?: Layer;
  boxes: Array<Omit<Box, "emissive" | "material"> & { emissive?: boolean; material?: BoxMaterial }>;
  seats?: Array<Partial<Seat> & { x: number; z: number }>;
  stations?: Array<Partial<Station> & { x: number; z: number; activity: Activity }>;
  textable?: boolean;
  screen?: boolean;
}

/** A validated custom kind as stored, broadcast ({type:"kind", kind}) and in the snapshot's customKinds. */
export interface CustomKind {
  kind: string;
  label: string;
  w: number;
  d: number;
  layer: Layer;
  boxes: Box[];
  seats: Seat[];
  stations: Station[];
  textable: boolean;
  screen: boolean;
  custom: true;
  /** Set by the server: who defined it and when. */
  by?: string;
  at?: number;
}

/** A seat placed in the world (cell units; yaw radians, 0 = facing +z). id = "<itemId>:s<i>". */
export interface PlacedSeat { id: string; item: string; x: number; z: number; yaw: number; height: number }
/** A station placed in the world. id = "<itemId>:t<i>". duration in seconds. */
export interface PlacedStation { id: string; item: string; x: number; z: number; yaw: number; activity: Activity; duration: number }

export interface Zone {
  /** The dominant tag (most items), suffixed -2, -3… when repeated. */
  name: string;
  /** Every functional tag in the cluster, most items first, e.g. ["lounge", "arcade"]. */
  tags: string[];
  x: number;
  z: number;
  w: number;
  d: number;
  items: number;
  kinds: string;
  seats: number;
  stations: number;
}

export interface DesignSummary {
  theme?: string;
  grid: Grid;
  zones: Zone[];
  /** Lone pieces not in any zone, e.g. "plant×4 beanbag×2". */
  scattered: string;
  freeFloor: { cells: number; pct: number; largestOpen: { x: number; z: number; w: number; d: number } };
  seats: number;
  stations: number;
  stationsByActivity: Partial<Record<Activity, number>>;
  /** Seat/station ids nobody can reach (off the floor or a station under furniture); not counted above. */
  unreachable: string[];
  wallItems: number;
  customKinds: number;
}

export const UNITS: number;
export const CUSTOM_KINDS_MAX: number;
export const BOXES_MAX: number;
export const HEIGHT_MAX: number;
export const FOOTPRINT_MAX: number;
export const SEATS_MAX: number;
export const STATIONS_MAX: number;
export const LABEL_MAX: number;
export const BOX_MATERIALS: readonly BoxMaterial[];
export const ACTIVITIES: readonly Activity[];
export const ACTIVITY_DURATION: Readonly<Record<Activity, number>>;
export const DURATION_MIN: number;
export const DURATION_MAX: number;
export const KIND_SLUG_RE: RegExp;
export const CUSTOM_LAYERS: readonly Layer[];

export function validateSeat(s: unknown, w: number, d: number, where?: string): Seat;
export function validateStation(s: unknown, w: number, d: number, where?: string): Station;
export function validateKindDef(def: unknown): CustomKind;
export function summarizeKind(k: CustomKind | import("./catalog.js").Kind): Record<string, unknown>;
export function spotsOf(item: Pick<Item, "id" | "kind" | "x" | "z" | "rot">, custom?: CustomKinds): { seats: PlacedSeat[]; stations: PlacedStation[] };
export function blockedCells(items: readonly Item[], grid: Grid, custom?: CustomKinds): Uint8Array;
export function spotReachable(spot: { x: number; z: number }, isSeat: boolean, blocked: Uint8Array, grid: Grid): boolean;
export function allSpots(items: readonly Item[], custom?: CustomKinds): { seats: PlacedSeat[]; stations: PlacedStation[] };
export function designSummary(o: { grid?: Grid; items: readonly Item[]; theme?: Theme; custom?: CustomKinds }): DesignSummary;
