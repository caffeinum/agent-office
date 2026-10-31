// Office theme = palette + materials. Shared by the Worker and the viewer (served as /shared/theme.js).
// Plain ESM, no DOM, no dependencies. Every function is pure; bad input throws ThemeError with a clear message.
//
// A theme is always complete when stored or sent; callers may set it partially (mergeTheme) or derive a
// whole one from three brand colours (brandTheme).

export const FLOOR_MATERIALS = Object.freeze(["wood", "tile", "concrete", "carpet"]);
export const ACCENT_WALL_MATERIALS = Object.freeze(["brick", "plaster", "wood-panels"]);
export const WALLS = Object.freeze(["back", "left"]);
export const LIGHTING = Object.freeze(["warm", "neutral", "cool"]);
export const NIGHT_WINDOWS = Object.freeze(["city", "stars", "aurora", "rain"]);
export const ACCENTS_MAX = 4;
export const ASSET_ID_RE = /^a[0-9a-f]{23}$/;

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** The look the office has always had: warm wood floor, cream walls, light desks with a blue accent. */
export const DEFAULT_THEME = deepFreeze({
  floor: { material: "wood", color: "#d9b086" },
  walls: { color: "#f3e6cf", trim: "#b98a5e", accent: null },
  desk: { wood: "#d6a46a", rail: "#f3ede2" },
  accents: ["#6aa6c9", "#ff8fa8", "#ffd45c"],
  lighting: "warm",
  nightWindow: "city",
  logo: null,
  logoOnSigns: false,
});

export class ThemeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ThemeError";
  }
}

const fail = (msg) => { throw new ThemeError(msg); };

function deepFreeze(o) {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function onlyKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`${where} has unknown field "${k}" (allowed: ${allowed.join(", ")})`);
}

function color(v, where) {
  if (typeof v !== "string" || !COLOR_RE.test(v)) fail(`${where} must be a #rrggbb colour, got ${JSON.stringify(v)}`);
  return v.toLowerCase();
}

function oneOf(v, list, where) {
  if (!list.includes(v)) fail(`${where} must be one of ${list.join(", ")}, got ${JSON.stringify(v)}`);
  return v;
}

/** Throws ThemeError unless `t` is a complete, valid theme. Returns a normalised copy (lowercase colours). */
export function validateTheme(t) {
  if (!isObj(t)) fail("theme is not an object");
  onlyKeys(t, Object.keys(DEFAULT_THEME), "theme");
  for (const k of Object.keys(DEFAULT_THEME)) if (!Object.hasOwn(t, k)) fail(`theme is missing "${k}"`);
  if (!isObj(t.floor)) fail("theme.floor must be {material, color}");
  onlyKeys(t.floor, ["material", "color"], "theme.floor");
  if (!isObj(t.walls)) fail("theme.walls must be {color, trim, accent}");
  onlyKeys(t.walls, ["color", "trim", "accent"], "theme.walls");
  let accent = null;
  if (t.walls.accent !== null) {
    if (!isObj(t.walls.accent)) fail("theme.walls.accent must be null or {material, color, wall}");
    onlyKeys(t.walls.accent, ["material", "color", "wall"], "theme.walls.accent");
    accent = {
      material: oneOf(t.walls.accent.material, ACCENT_WALL_MATERIALS, "theme.walls.accent.material"),
      color: color(t.walls.accent.color, "theme.walls.accent.color"),
      wall: oneOf(t.walls.accent.wall, WALLS, "theme.walls.accent.wall"),
    };
  }
  if (!isObj(t.desk)) fail("theme.desk must be {wood, rail}");
  onlyKeys(t.desk, ["wood", "rail"], "theme.desk");
  if (!Array.isArray(t.accents) || t.accents.length < 1 || t.accents.length > ACCENTS_MAX) fail(`theme.accents must be 1-${ACCENTS_MAX} colours`);
  if (t.logo !== null && (typeof t.logo !== "string" || !ASSET_ID_RE.test(t.logo))) fail(`theme.logo must be null or an asset id from office_upload, got ${JSON.stringify(t.logo)}`);
  if (typeof t.logoOnSigns !== "boolean") fail("theme.logoOnSigns must be true or false");
  return {
    floor: { material: oneOf(t.floor.material, FLOOR_MATERIALS, "theme.floor.material"), color: color(t.floor.color, "theme.floor.color") },
    walls: { color: color(t.walls.color, "theme.walls.color"), trim: color(t.walls.trim, "theme.walls.trim"), accent },
    desk: { wood: color(t.desk.wood, "theme.desk.wood"), rail: color(t.desk.rail, "theme.desk.rail") },
    accents: t.accents.map((c, i) => color(c, `theme.accents[${i}]`)),
    lighting: oneOf(t.lighting, LIGHTING, "theme.lighting"),
    nightWindow: oneOf(t.nightWindow, NIGHT_WINDOWS, "theme.nightWindow"),
    logo: t.logo,
    logoOnSigns: t.logoOnSigns,
  };
}

/**
 * Applies a partial theme on top of a complete one. Objects merge one level deep (floor, walls, desk,
 * walls.accent); accents replace the whole list; walls.accent: null removes the accent wall.
 */
export function mergeTheme(base, partial) {
  const b = validateTheme(base);
  if (!isObj(partial)) fail("theme patch is not an object");
  onlyKeys(partial, Object.keys(DEFAULT_THEME), "theme patch");
  const next = { ...b, floor: { ...b.floor }, walls: { ...b.walls }, desk: { ...b.desk } };
  for (const key of ["floor", "desk"]) {
    if (partial[key] === undefined) continue;
    if (!isObj(partial[key])) fail(`theme.${key} must be an object`);
    Object.assign(next[key], partial[key]);
  }
  if (partial.walls !== undefined) {
    if (!isObj(partial.walls)) fail("theme.walls must be an object");
    const { accent, ...rest } = partial.walls;
    Object.assign(next.walls, rest);
    if (accent === null) next.walls.accent = null;
    else if (accent !== undefined) {
      if (!isObj(accent)) fail("theme.walls.accent must be null or {material, color, wall}");
      next.walls.accent = { material: "brick", wall: "back", ...(b.walls.accent ?? {}), ...accent };
    }
  }
  for (const key of ["accents", "lighting", "nightWindow", "logo", "logoOnSigns"]) if (partial[key] !== undefined) next[key] = partial[key];
  return validateTheme(next);
}

// ---------- colour maths (sRGB hex ↔ HSL), exported for the viewer ----------

export function hexToRgb(hex) {
  color(hex, "colour");
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear blend in sRGB: t = 0 → a, t = 1 → b. */
export function mixHex(a, b, t) {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  return rgbToHex(pa.map((v, i) => v + (pb[i] - v) * t));
}

export function hexToHsl(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToHex([h, s, l]) {
  const hue = ((h % 360) + 360) % 360 / 360;
  const sat = Math.max(0, Math.min(1, s)), lig = Math.max(0, Math.min(1, l));
  if (sat === 0) return rgbToHex([lig * 255, lig * 255, lig * 255]);
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const ch = (t) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return rgbToHex([ch(hue + 1 / 3) * 255, ch(hue) * 255, ch(hue - 1 / 3) * 255]);
}

/** Relative luminance (WCAG), 0 = black, 1 = white. */
export function luminance(hex) {
  const lin = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

// ---------- brand → theme ----------

/**
 * Derives a complete, coherent theme from brand colours. Deterministic and pure.
 * brand: {primary, dark?, accent?} — dark defaults to a near-black of the primary's hue, accent to a
 * soft tint of it. The primary leads (accent wall, desk rails, first accent); dark grounds (trim, floor
 * depth); the soft accent tints the walls so the room stays light enough to read characters against.
 */
export function brandTheme(brand, base = DEFAULT_THEME) {
  if (!isObj(brand)) fail("brand must be {primary, dark?, accent?}");
  onlyKeys(brand, ["primary", "dark", "accent"], "brand");
  const primary = color(brand.primary, "brand.primary");
  const [ph, ps] = hexToHsl(primary);
  const dark = brand.dark === undefined ? hslToHex([ph, Math.min(ps, 0.25), 0.09]) : color(brand.dark, "brand.dark");
  // derived soft accent (rugs, sofas): calmer still when the primary is very saturated
  const accent = brand.accent === undefined ? hslToHex([ph, Math.min(ps, ps > 0.8 ? 0.35 : 0.45), 0.7]) : color(brand.accent, "brand.accent");
  const [, , dl] = hexToHsl(dark);

  const warm = ph < 70 || ph >= 290;
  const cool = ph >= 160 && ph < 260;
  const lighting = warm ? "warm" : cool ? "cool" : "neutral";

  // walls: off-white tinted towards the soft accent, never darker than a light pastel
  const wallsColor = mixHex("#f6f3ee", accent, 0.22);
  const trim = mixHex(dark, primary, 0.15);
  // statement wall: brick in a deepened, muted primary on the back wall (a full wall of pure brand red is too loud)
  const [ah, as, al] = hexToHsl(primary);
  const brick = hslToHex([ah, Math.min(as, 0.55), Math.max(0.35, Math.min(0.45, al * 0.85))]);
  // floor: a near-black brand (dl < 0.2) reads as polished concrete; otherwise a warm wood pulled to the dark tone
  const floor = dl < 0.2
    ? { material: "concrete", color: mixHex(dark, "#b9b4ad", 0.62) }
    : { material: "wood", color: mixHex("#c79a6b", dark, 0.25) };
  // desks: dark tops against light walls when the brand is near-black, light oak otherwise; rail = primary
  const desk = { wood: dl < 0.2 ? mixHex(dark, "#ffffff", 0.14) : mixHex("#d6a46a", accent, 0.2), rail: primary };

  const b = validateTheme(base);
  return validateTheme({
    floor,
    walls: { color: wallsColor, trim, accent: { material: "brick", color: brick, wall: "back" } },
    desk,
    accents: [primary, accent, dark],
    lighting,
    nightWindow: "city",
    logo: b.logo,
    logoOnSigns: b.logoOnSigns,
  });
}

/** One-line human summary, e.g. for office_look's design summary. */
export function describeTheme(t) {
  const v = validateTheme(t);
  const accentWall = v.walls.accent ? `, ${v.walls.accent.material} accent wall ${v.walls.accent.color} (${v.walls.accent.wall})` : "";
  return `${v.floor.material} floor ${v.floor.color}; walls ${v.walls.color}${accentWall}; desks ${v.desk.wood} rail ${v.desk.rail}; accents ${v.accents.join(" ")}; ${v.lighting} light; ${v.logo ? `logo ${v.logo}` : "no logo"}`;
}
