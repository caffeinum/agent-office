// City entry, called from public/js/app.js boot() on /city/:id. Injects /css/city.css, builds the scene for
// /city/{id}/manifest.json, loads companies.json and hands both to W6's mountCityUi. Owns the W5 URL state:
// ?at=x,z,dist (kept in sync with the camera), ?theme=day|night and ?debug=1 (stats HUD).

import { validateCompanies } from "../../shared/city.js";
import { createCityScene } from "./scene.js";
import { fail } from "./loader.js";
import { mountCityUi } from "./ui.js";

/** Pure. "x,z,dist" → {x, z, dist}; null when absent; throws on anything malformed. */
export function parseAt(value) {
  if (value == null) return null;
  const parts = value.split(",");
  const nums = parts.map(Number);
  if (parts.length !== 3 || nums.some((n) => !Number.isFinite(n)) || nums[2] <= 0) throw new Error(`?at=${value}: expected x,z,dist (dist > 0)`);
  return { x: nums[0], z: nums[1], dist: nums[2] };
}

/** Pure. ?theme → "day" | "night"; day when absent; throws on anything else. */
export function parseTheme(value) {
  if (value == null) return "day";
  if (value !== "day" && value !== "night") throw new Error(`?theme=${value}: expected day or night`);
  return value;
}

export const formatAt = (x, z, dist) => `${Math.round(x)},${Math.round(z)},${Math.round(dist)}`;

function injectCss() {
  if (document.querySelector('link[href="/css/city.css"]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/css/city.css";
  document.head.appendChild(link);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error(`${url}: expected JSON, got HTML`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${url}: not JSON (${e.message})`);
  }
}

/** Mirror the camera into ?at= (replaceState, checked once a second), keeping every other parameter. */
function syncAt(city) {
  let last = location.search;
  setInterval(() => {
    const t = city.target();
    const params = new URLSearchParams(location.search);
    params.set("at", formatAt(t.x, t.z, city.cameraDistance()));
    const next = `?${params.toString().replace(/%2C/g, ",")}`;
    if (next === last) return;
    last = next;
    history.replaceState(history.state, "", `${location.pathname}${next}${location.hash}`);
  }, 1000);
}

function debugHud(city, root) {
  const el = document.createElement("pre");
  el.className = "city-debug";
  el.style.cssText = "position:absolute;right:8px;bottom:36px;z-index:20;margin:0;padding:6px 8px;border-radius:6px;background:rgba(0,0,0,.6);"
    + "color:#e8f5e8;font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none;max-width:calc(100vw - 16px);white-space:pre-wrap";
  root.appendChild(el);
  let lastPick = "—";
  city.onTap(({ hit }) => {
    lastPick = hit ? `${hit.kind} ${hit.x},${hit.y},${hit.z}${hit.buildingId != null ? ` #${hit.buildingId}` : ""}` : "nothing";
    console.info("city pick", hit);
  });
  setInterval(() => {
    const s = city.stats(), t = city.target();
    el.textContent = `${s.fps} fps · ${s.calls} calls · ${(s.tris / 1000).toFixed(0)}k tris · dpr ${city.stage.pixelRatio}\n`
      + `lod0 ${s.chunks.lod0} · r1 ${s.chunks.regions1} · r2 ${s.chunks.regions2} · pending ${s.chunks.pending}\n`
      + `target ${formatAt(t.x, t.z, city.cameraDistance())} ground ${city.groundAt(t.x, t.z)}\npick ${lastPick}`;
  }, 500);
}

/** Build the scene for /city/{id}/manifest.json, then mountCityUi. → Promise<void> */
export async function bootCity(id) {
  try {
    injectCss();
    const params = new URLSearchParams(location.search);
    const theme = parseTheme(params.get("theme"));
    const at = parseAt(params.get("at"));
    document.title = `${id} · agent office city`;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";

    const root = document.createElement("main");
    root.id = "city";
    root.dataset.theme = theme;
    root.style.cssText = "position:fixed;inset:0;overflow:hidden";
    const stageEl = document.createElement("div");
    stageEl.className = "city-stage";
    stageEl.style.cssText = "position:absolute;inset:0";
    root.appendChild(stageEl);
    document.body.appendChild(root);

    const city = await createCityScene(stageEl, { manifestUrl: `/city/${id}/manifest.json`, theme, at });
    document.title = `${city.manifest.name} · agent office`;
    const companies = validateCompanies(await fetchJson(`/city/${id}/companies.json`), city.manifest);
    mountCityUi(city, companies, root);
    syncAt(city);
    if (params.get("debug") === "1") debugHud(city, root);
  } catch (e) {
    throw fail(e);
  }
}
