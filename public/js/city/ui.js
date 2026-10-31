// City UI entry point, called by W5's city/app.js: labels, building panel, search, attribution footer,
// ?c=<companyId> fly-to and ?pins=demo demo pins.

import { validateCompanies } from "../../shared/city.js";
import { createLabels } from "./labels.js";
import { buildingInfo, createPanel, siteInfo } from "./panel.js";
import { createSearch } from "./search.js";
import { createPins, demoPresence, PIN_SIZE } from "./pins.js";

const TAP_PX = 6;
const TAP_MS = 600;

/**
 * Pure. Camera distance that frames a site: the target sits at street level and the chip at roofY + 2, so at the
 * spawn tilt (polar 0.95) and fov 30 the chip stays inside the frame only from about 4.5 × the height in blocks.
 */
export function focusDistance(site) {
  return Math.round(Math.min(900, Math.max(160, (site.heightM / 3) * 4.5)));
}

/** Projected px heights of an agent pin and of a 1-block column standing on the same spot. */
export function pinScale(city, x, y, z) {
  const px = (h) => {
    const a = city.worldToScreen(x, y, z), b = city.worldToScreen(x, y + h, z);
    return a.visible && b.visible ? Math.abs(a.y - b.y) : null;
  };
  const pinPx = px(PIN_SIZE.h), blockPx = px(1);
  return { dist: city.cameraDistance(), pinPx, blockPx, ok: pinPx !== null && blockPx !== null && pinPx < blockPx };
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function primaryOf(sites, companyId) {
  return sites.find((s) => s.companyId === companyId && s.primary) ?? null;
}

function setUrlCompany(companyId) {
  const url = new URL(location.href);
  if (companyId) url.searchParams.set("c", companyId);
  else url.searchParams.delete("c");
  history.replaceState(history.state, "", url);
}

/** → {destroy()} */
export function mountCityUi(city, companies, root) {
  validateCompanies(companies, city.manifest);
  const { sites } = companies;
  const params = new URLSearchParams(location.search);
  const debug = params.get("debug") === "1";

  const ui = el("div", "cu-ui");
  ui.dataset.theme = params.get("theme") === "night" ? "night" : "day";
  root.appendChild(ui);

  const footer = el("footer", "cu-attrib cu-glass", city.manifest.attribution.join(" · "));
  footer.title = footer.textContent;
  footer.addEventListener("click", () => footer.classList.toggle("open"));

  const panel = createPanel(ui, { onClose: () => setUrlCompany(null) });

  function flyTo(site) {
    city.focus(site.block.x + 0.5, site.block.z + 0.5, focusDistance(site));
    panel.show(siteInfo(sites, site));
    setUrlCompany(site.companyId);
  }

  const labels = createLabels(city, sites, ui, { onPick: (g) => flyTo(g.sites[0]) });
  const search = createSearch(ui, sites, flyTo);
  ui.appendChild(footer);

  const pins = createPins(city, sites, { onCounts: (counts) => labels.setBadges(counts) });
  if (params.get("pins") === "demo") pins.setPresence(demoPresence(sites));

  function onTap(clientX, clientY) {
    const hit = city.pick(clientX, clientY);
    if (!hit || hit.kind !== "building") {
      panel.hide();
      return;
    }
    const building = city.buildingAt(hit.x, hit.z);
    if (!building || building.id !== hit.buildingId) {
      throw new Error(`city ui: pick hit building ${hit.buildingId} at ${hit.x},${hit.z} but buildingAt gave ${JSON.stringify(building)}`);
    }
    const info = buildingInfo(sites, building);
    panel.show(info);
    setUrlCompany(info.sites.find((s) => s.primary)?.companyId ?? null);
  }

  let down = null;
  const onDown = (e) => {
    if (!(e.target instanceof HTMLCanvasElement)) return;
    down = e.isPrimary ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), multi: false } : down && { ...down, multi: true };
  };
  const onUp = (e) => {
    if (!down || e.pointerId !== down.id) return;
    const d = down;
    down = null;
    if (d.multi || performance.now() - d.t > TAP_MS || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_PX) return;
    onTap(e.clientX, e.clientY);
  };
  const onKey = (e) => { if (e.key === "Escape") panel.hide(); };
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("keydown", onKey);

  const debugSite = sites.find((s) => s.primary && s.status !== "former") ?? sites[0];
  let lastLog = 0;
  let alive = true;
  const off = city.onFrame(() => {
    if (!alive) return;
    labels.update();
    pins.update();
    if (debug && debugSite && performance.now() - lastLog > 1000) {
      lastLog = performance.now();
      const { x, y, z } = debugSite.anchor;
      const r = pinScale(city, x + 0.5, y, z + 0.5);
      console.log(`[city ui] pin scale at d=${r.dist.toFixed(0)}: pin ${r.pinPx?.toFixed(2)} px, 1-block column ${r.blockPx?.toFixed(2)} px → ${r.ok ? "ok" : "FAIL"}`);
    }
  });

  if (debug) window.__cityUi = { pinScale: (x, y, z) => pinScale(city, x, y, z), flyTo: (companyId) => flyTo(primaryOf(sites, companyId)), panel, labels, pins };

  const wanted = params.get("c");
  if (wanted) {
    const site = primaryOf(sites, wanted);
    if (site) flyTo(site);
    else {
      const err = el("div", "cu-error", `no company "${wanted}" in this city`);
      err.setAttribute("role", "alert");
      ui.appendChild(err);
      console.error(`city ui: ?c=${wanted} matches no company in ${companies.city}`);
    }
  }

  function destroy() {
    alive = false;
    if (typeof off === "function") off();
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("keydown", onKey);
    pins.dispose();
    labels.destroy();
    search.destroy();
    ui.remove();
    if (window.__cityUi) delete window.__cityUi;
  }

  return { destroy };
}
