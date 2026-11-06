// Daylight over the office, which is in San Francisco: where the sun is at a moment, and the light that makes, blended
// from day through a golden dusk into night (and back at dawn). Pure, so the browser and the Apple TV light the office
// the same way at the same moment.

import { TIMES_OF_DAY } from "./model.js";

export const SF = Object.freeze({ lat: 37.7749, lon: -122.4194 });

const RAD = Math.PI / 180;

/** The sun seen from (lat, lon) at `date`: elevation and azimuth (degrees; azimuth from north, clockwise). */
export function sunPosition(date, { lat, lon } = SF) {
  const d = date.getTime() / 86_400_000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD; // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * RAD; // obliquity
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) * 15; // degrees
  const ha = (gmst + lon) * RAD - ra;
  const la = lat * RAD;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { elevation: el / RAD, azimuth: ((az / RAD) + 360) % 360 };
}

/** Golden-hour tints the day blends through as the sun gets low. */
const GOLDEN = { sun: "#ffa863", sky: "#f3c6a3", fog: "#efc4a6" };
/** The moon's fixed light direction at night (the web's old sun direction). */
const MOON_DIR = [-0.55, 1, 0.75];
/** The sun's elevation where the lights start to change (°), where it's full night, and the lowest the shadows go. */
const DUSK_START = 6, NIGHT_AT = -6, SHADOW_MIN = 12;

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function mix(a, b, k) {
  const x = hex(a), y = hex(b);
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, "0")).join("");
}

/**
 * The light for darkness `dark` (0 day … 1 night) and golden-hour strength `golden` (0…1) under a theme's mood:
 * every TIMES_OF_DAY number blended, the final colours (hemiSky, hemiGround, sunColor, fog), `sunDir` (unit vector
 * towards the light, world axes: north = -z, east = +x) and `name` ("night" once it's more than half dark: textures,
 * city lights switch there), `view` ("day" | "dusk" | "night": the windows' and the sky's picture) and `windowLight`
 * (window glass brightness).
 */
export function lightFor(dark, golden, sunDir, mood) {
  const D = TIMES_OF_DAY.day, N = TIMES_OF_DAY.night;
  const out = { name: dark > 0.5 ? "night" : "day", dark, golden };
  for (const k of Object.keys(D)) if (typeof D[k] === "number") out[k] = D[k] + (N[k] - D[k]) * dark;
  const g = golden * (1 - dark);
  out.sunColor = mix(mix(mood.sun, GOLDEN.sun, g), N.sunColor, dark);
  out.hemiSky = mix(mix(mood.sky, GOLDEN.sky, g * 0.6), mood.nightSky, dark);
  out.hemiGround = mix(mood.ground, N.hemiGround, dark);
  out.fog = mix(mix(D.fog, GOLDEN.fog, g), N.fog, dark);
  out.sunDir = sunDir;
  // what the windows and the sky behind the office show, and how bright the window glass is: the dusk view through the
  // golden hour, dimming as the sun sets until the night view takes over
  out.view = dark > 0.5 ? "night" : golden > 0.4 ? "dusk" : "day";
  out.windowLight = out.view === "night" ? 0.95 : 1.05 * (1 - dark * 0.8);
  return out;
}

/** A fixed day or night (the viewer's toggle, AO_TIME), with the default light directions. */
export function fixedLight(name, mood) {
  if (name !== "day" && name !== "night") throw new Error(`unknown time of day ${JSON.stringify(name)}`);
  return lightFor(name === "night" ? 1 : 0, 0, unit(name === "night" ? MOON_DIR : MOON_DIR), mood);
}

/** The office's light at `date` in San Francisco: dusk and dawn blend over the sun's last/first ~12° (~45 min). */
export function lightAt(date, mood) {
  const { elevation, azimuth } = sunPosition(date);
  const dark = smooth(DUSK_START, NIGHT_AT, elevation);
  const golden = 1 - smooth(4, 16, elevation);
  // the sun's own direction by day (kept a little high so shadows stay on the island), the moon's by night
  const el = Math.max(SHADOW_MIN, elevation) * RAD, az = azimuth * RAD;
  const sunDir = [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
  const moon = unit(MOON_DIR);
  const dir = unit(sunDir.map((v, i) => v + (moon[i] - v) * dark));
  return lightFor(dark, golden, dir, mood);
}

function unit(v) {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
}

/** The light rounded to the half minute: viewers re-light the scene only when this changes. */
export const lightKey = (date) => Math.floor(date.getTime() / 30_000);
