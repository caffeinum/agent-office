export type FloorMaterial = "wood" | "tile" | "concrete" | "carpet";
export type AccentWallMaterial = "brick" | "plaster" | "wood-panels";
export type WallName = "back" | "left";
export type Lighting = "warm" | "neutral" | "cool";
export type NightWindow = "city" | "stars" | "aurora" | "rain";

export interface Theme {
  floor: { material: FloorMaterial; color: string };
  walls: { color: string; trim: string; accent: null | { material: AccentWallMaterial; color: string; wall: WallName } };
  /** Desk top wood tone and the accent rail/body colour. */
  desk: { wood: string; rail: string };
  /** 1-4 colours used by chairs, rugs, signage (accents[0] leads). */
  accents: string[];
  lighting: Lighting;
  nightWindow: NightWindow;
  /** Asset id (office_upload) shown on the TV, every desk monitor and every kind with screen: true. */
  logo: string | null;
  /** Also print the logo on signs. */
  logoOnSigns: boolean;
}

export type ThemePatch = {
  floor?: Partial<Theme["floor"]>;
  walls?: Partial<Omit<Theme["walls"], "accent">> & { accent?: null | Partial<NonNullable<Theme["walls"]["accent"]>> };
  desk?: Partial<Theme["desk"]>;
  accents?: string[];
  lighting?: Lighting;
  nightWindow?: NightWindow;
  logo?: string | null;
  logoOnSigns?: boolean;
};

export interface Brand {
  primary: string;
  dark?: string;
  accent?: string;
}

export const FLOOR_MATERIALS: readonly FloorMaterial[];
export const ACCENT_WALL_MATERIALS: readonly AccentWallMaterial[];
export const WALLS: readonly WallName[];
export const LIGHTING: readonly Lighting[];
export const NIGHT_WINDOWS: readonly NightWindow[];
export const ACCENTS_MAX: number;
export const ASSET_ID_RE: RegExp;
export const DEFAULT_THEME: Readonly<Theme>;

export class ThemeError extends Error {}

export function validateTheme(t: unknown): Theme;
export function mergeTheme(base: Theme, partial: ThemePatch): Theme;
export function brandTheme(brand: Brand, base?: Theme): Theme;
export function describeTheme(t: Theme): string;
export function hexToRgb(hex: string): [number, number, number];
export function rgbToHex(rgb: readonly number[]): string;
export function mixHex(a: string, b: string, t: number): string;
export function hexToHsl(hex: string): [number, number, number];
export function hslToHex(hsl: readonly number[]): string;
export function luminance(hex: string): number;
