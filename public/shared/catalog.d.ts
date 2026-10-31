export type Rot = 0 | 90 | 180 | 270;
export type Layer = "floor" | "object" | "wall";
export type KindName =
  | "desk" | "chair" | "plant" | "sofa" | "lamp" | "bookshelf" | "rug" | "whiteboard" | "sign" | "fridge"
  | "coffee-machine" | "table" | "tv" | "window" | "poster" | "server-rack" | "beanbag";

export type Activity = "coffee" | "snack" | "read" | "play" | "water-plants" | "whiteboard" | "chat" | "think" | "watch";

/** Local model space: 16 units per cell, origin at the footprint's min corner at rot 0, front faces +z. */
export interface Seat {
  readonly x: number;
  readonly z: number;
  /** Way the sitter faces at item rot 0 (0 = +z, the model's front). */
  readonly rot: Rot;
  /** Seat surface height in units (16 = one cell). */
  readonly height: number;
}

export interface Station {
  readonly x: number;
  readonly z: number;
  readonly rot: Rot;
  readonly activity: Activity;
  /** Seconds; default per activity (ACTIVITY_DURATION in kinds.js). */
  readonly duration?: number;
}

export interface Kind {
  readonly w: number;
  readonly d: number;
  readonly label: string;
  readonly layer: Layer;
  readonly textable?: boolean;
  /** Desks: the assigned work seat (seatOf). */
  readonly seat?: boolean;
  /** Shows the office logo (theme.logo) on its screen. */
  readonly screen?: boolean;
  readonly seats?: readonly Seat[];
  readonly stations?: readonly Station[];
}

/** An office's custom kinds by slug (CustomKind from kinds.d.ts is assignable). */
export type CustomKinds = Readonly<Record<string, Kind>>;

export interface Item {
  id: string;
  kind: string;
  x: number;
  z: number;
  rot: Rot;
  text?: string;
  color?: string;
  by: string;
  at: number;
}

export interface Grid { w: number; d: number }
export interface Footprint { x: number; z: number; w: number; d: number }

export type Op =
  | { op: "add"; kind: string; x: number; z: number; rot?: Rot; text?: string; color?: string }
  | { op: "remove"; id: string }
  | { op: "move"; id: string; x: number; z: number }
  | { op: "rotate"; id: string; rot: Rot }
  | { op: "text"; id: string; text: string };

export type OpResult = { items: Item[]; item: Item; removed?: undefined } | { items: Item[]; removed: string; item?: undefined };

export const GRID: Readonly<Grid>;
export const GRID_MIN: number;
export const GRID_MAX: number;
export const ROTS: readonly Rot[];
export const TEXT_MAX: number;
export const NAME_MAX: number;
export const ACTIVITY_MAX: number;
export const MAX_ITEMS: number;
export const MAX_AGENTS: number;
export const LAYERS: readonly Layer[];
export const KINDS: Readonly<Record<KindName, Kind>>;
export const KIND_NAMES: readonly KindName[];
export const OPS: readonly Op["op"][];

export class OfficeError extends Error {}

export function kindOf(kind: unknown, custom?: CustomKinds): Kind | undefined;
export function footprint(item: Pick<Item, "kind" | "x" | "z" | "rot">, custom?: CustomKinds): Footprint;
export function overlaps(a: Footprint, b: Footprint): boolean;
export function validateItem<T extends Item>(item: T, others: readonly Item[], grid?: Grid, custom?: CustomKinds): T;
export function nextId(items: readonly Item[], kind: string): string;
export function applyOp(items: readonly Item[], op: Op, by: string, opts?: { grid?: Grid; now?: number; kinds?: CustomKinds }): OpResult;
export function seatOf(desk: Pick<Item, "kind" | "x" | "z" | "rot">): { x: number; z: number; yaw: number };
export function defaultLayout(now?: number): Item[];

export const SPOOF_CHARS_RE: RegExp;
export const SPOOF_LINE_RE: RegExp;
