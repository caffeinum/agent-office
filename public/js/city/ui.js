// City UI entry point, called by city/app.js: labels, building panel with "here now", search over companies,
// places and agents, the people list with the city chat tail, live walkers and office pins from the City DO feed,
// follow (?follow=<walkerId>, a tap on a walker, the people list; a pan cancels it), attribution footer and ?c=.

import { validateCompanies } from "../../shared/city.js";
import { createLabels } from "./labels.js";
import { fail } from "./loader.js";
import { connectLive, createLiveState, insideCounts, presenceForPins } from "./live.js";
import { buildingInfo, createPanel, createPeople, siteInfo, whoIsHere } from "./panel.js";
import { createSearch } from "./search.js";
import { createPins, PIN_SIZE } from "./pins.js";
import { createWalkers } from "./walkers.js";

const TAP_PX = 6;
const TAP_MS = 600;
export const PAN_PX = 6;
export const PLACE_DIST = 220;
const PAN_KEYS = new Set(["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"]);

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

/** Pure. "x,z,dist,az,polar" → {x, z, dist, az, polar} (az, polar in radians); null when absent; throws on anything malformed. */
export function parseCam(value) {
  if (value == null) return null;
  const parts = value.split(",");
  const n = parts.map(Number);
  if (parts.length !== 5 || n.some((v) => !Number.isFinite(v))) throw new Error(`?cam=${value}: expected x,z,dist,az,polar`);
  if (!(n[2] > 0)) throw new Error(`?cam=${value}: dist must be > 0`);
  if (!(n[4] >= 0 && n[4] <= Math.PI / 2)) throw new Error(`?cam=${value}: polar must be within 0..π/2 radians`);
  return { x: n[0], z: n[1], dist: n[2], az: n[3], polar: n[4] };
}

/** Pure. Inverse of parseCam: blocks to integers, angles to 3 decimals. */
export const formatCam = ({ x, z, dist, az, polar }) => `${Math.round(x)},${Math.round(z)},${Math.round(dist)},${az.toFixed(3)},${polar.toFixed(3)}`;

/** Pure. Camera position and orbit target → {x, z, dist, az, polar} (three.js spherical: polar from +y, az from +z toward +x). */
export function camState(position, target) {
  const dx = position.x - target.x, dy = position.y - target.y, dz = position.z - target.z;
  const dist = Math.hypot(dx, dy, dz);
  if (!(dist > 0)) throw new Error("camState: camera sits on its target");
  return { x: target.x, z: target.z, dist, az: Math.atan2(dx, dz), polar: Math.acos(Math.max(-1, Math.min(1, dy / dist))) };
}

/** Pure. ws(s)://host/city/{id}/ws for a page at `href`. */
export function liveUrlFor(href, id) {
  const u = new URL(`/city/${id}/ws`, href);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
}

/** Writes pins' "N here / M inside" text into the label badges (labels.setBadges, then the text). */
export function applyBadges(labels, counts) {
  labels.setBadges(counts);
  for (const g of labels.groups) {
    for (const [companyId, badge] of g.rows) {
      const text = counts.get(companyId)?.text ?? "";
      badge.textContent = text;
      badge.hidden = text === "";
    }
    g.size = null;
  }
}

export const FOLLOW_VIEWS = Object.freeze(["orbit", "street"]);

/** Pure. ?view → "orbit" | "street"; orbit when absent; throws on anything else. */
export function parseView(value) {
  if (value == null) return "orbit";
  if (!FOLLOW_VIEWS.includes(value)) throw new Error(`?view=${value}: expected ${FOLLOW_VIEWS.join(" or ")}`);
  return value;
}

/**
 * Follow controller over the scene's follow(getPos, {view})/unfollow() (W4). getPos reads the live interpolation
 * (with heading, for the street view); a walker that left keeps its last position until the UI unfollows.
 * → {follow(id), unfollow(), setView(view), following, view}
 */
export function createFollow(city, live, { onChange = () => {}, now = () => Date.now(), view = "orbit" } = {}) {
  if (typeof city.follow !== "function" || typeof city.unfollow !== "function") {
    throw new Error("city scene has no follow(getPos)/unfollow(): W4's scene API (spec-v2 §8 W4) is required to follow a walker");
  }
  let id = null, last = null, mode = parseView(view);
  const getPos = () => {
    const p = live.position(id, now());
    if (p) last = { x: p.x, y: typeof city.standY === "function" ? city.standY(p.x, p.y, p.z) : p.y, z: p.z, heading: p.heading };
    return last;
  };
  return {
    follow(next) {
      if (!live.walker(next)) throw new Error(`follow: no walker ${JSON.stringify(next)} in the city`);
      id = next;
      last = null;
      city.follow(getPos, { view: mode });
      onChange(id);
    },
    /** "orbit" | "street": applied now when following, and to the next follow. */
    setView(next) {
      mode = parseView(next);
      if (id !== null) {
        if (typeof city.setFollowView !== "function") throw new Error("city scene has no setFollowView(view): the street view needs it");
        city.setFollowView(mode);
      }
      onChange(id);
    },
    get view() { return mode; },
    unfollow() {
      if (id === null) return;
      id = null;
      city.unfollow();
      onChange(null);
    },
    get following() { return id; },
  };
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

function setUrlParam(key, value) {
  const url = new URL(location.href);
  if (value) url.searchParams.set(key, value);
  else url.searchParams.delete(key);
  history.replaceState(history.state, "", url);
}

/** opts: {places: PlacesDoc, walk: WalkGraph, liveUrl: string | null}. → {destroy(), live} */
export function mountCityUi(city, companies, root, { places, walk, liveUrl }) {
  validateCompanies(companies, city.manifest);
  if (!places || !Array.isArray(places.places)) throw new Error("mountCityUi: places.json is required");
  if (!walk) throw new Error("mountCityUi: walk.bin is required (walker sidewalk offsets)");
  const { sites } = companies;
  const params = new URLSearchParams(location.search);
  const debug = params.get("debug") === "1";

  const ui = el("div", "cu-ui");
  ui.dataset.theme = params.get("theme") === "night" ? "night" : "day";
  root.appendChild(ui);

  const footer = el("footer", "cu-attrib cu-glass", city.manifest.attribution.join(" · "));
  footer.title = footer.textContent;
  footer.addEventListener("click", () => footer.classList.toggle("open"));

  const live = createLiveState({ graph: walk });
  let follower = null;
  const initialView = parseView(params.get("view"));
  let dirty = true;
  const guard = (fn) => (...a) => { try { return fn(...a); } catch (e) { throw fail(e); } };

  const viewBtn = el("button", "cu-view cu-glass", "street view");
  viewBtn.type = "button";
  viewBtn.hidden = true;
  const follow = guard((id) => {
    follower ??= createFollow(city, live, {
      view: initialView,
      onChange: (fid) => {
        walkers.select(fid);
        setUrlParam("follow", fid);
        setUrlParam("view", fid && follower?.view === "street" ? "street" : null);
        viewBtn.hidden = !fid;
        viewBtn.textContent = follower?.view === "street" ? "orbit view" : "street view";
        viewBtn.setAttribute("aria-pressed", String(follower?.view === "street"));
        dirty = true;
      },
    });
    follower.follow(id);
  });
  viewBtn.addEventListener("click", guard(() => follower?.setView(follower.view === "street" ? "orbit" : "street")));
  const unfollow = () => follower?.unfollow();

  const panel = createPanel(ui, { onClose: () => setUrlParam("c", null), onFollow: follow });

  function flyTo(site) {
    unfollow();
    city.focus(site.block.x + 0.5, site.block.z + 0.5, focusDistance(site));
    panel.show(siteInfo(sites, site));
    setUrlParam("c", site.companyId);
    dirty = true;
  }

  const labels = createLabels(city, sites, ui, { onPick: (g) => flyTo(g.sites[0]) });
  const search = createSearch(ui, () => ({ sites, places: places.places, walkers: live.ready ? live.walkers() : [] }), guard((r) => {
    if (r.kind === "company") flyTo(r.item);
    else if (r.kind === "place") { unfollow(); city.focus(r.item.x, r.item.z, PLACE_DIST); }
    else follow(r.id);
  }));
  const people = createPeople(ui, { onFollow: follow });
  const walkers = createWalkers(city, live, ui, { onChipPick: follow });
  ui.appendChild(viewBtn);
  ui.appendChild(footer);

  const pins = createPins(city, sites, { onCounts: (counts) => applyBadges(labels, counts) });

  live.onChange((kind) => {
    dirty = true;
    if (kind === "left" && follower?.following && !live.walker(follower.following)) unfollow();
  });

  const positionOf = (id) => live.position(id);
  function refresh() {
    if (!live.ready) return;
    pins.setPresence(presenceForPins(live.presence()));
    pins.setInside(insideCounts(live.presence()));
    people.render({ walkers: live.walkers(), positionOf, chat: live.chat(), selected: follower?.following ?? null });
    if (panel.open && panel.info) panel.setPeople(whoIsHere(panel.info, { presence: live.presence(), walkers: live.walkers(), positionOf }));
  }

  const wantFollow = params.get("follow");
  let socket = null;
  if (liveUrl) {
    let first = true;
    socket = connectLive(liveUrl, live, {
      onStatus: (s, detail) => {
        people.setStatus(s, detail);
        if (s !== "live" || !first) return;
        first = false;
        if (!wantFollow) return;
        // outside the socket's message handler: a follow failure is a UI error, not a bad frame to reconnect over
        setTimeout(() => {
          if (live.walker(wantFollow)) follow(wantFollow);
          else showError(`no walker "${wantFollow}" in the city right now`);
        }, 0);
      },
      onError: (e) => fail(e),
    });
  } else {
    people.setStatus("off");
    if (wantFollow) showError(`?follow=${wantFollow} needs the live feed, which is off (?live=0)`);
  }

  function showError(text) {
    const err = el("div", "cu-error", text);
    err.setAttribute("role", "alert");
    ui.appendChild(err);
    console.error(`city ui: ${text}`);
  }

  function onTap(clientX, clientY) {
    const wid = walkers.pick(clientX, clientY);
    if (wid) { follow(wid); return; }
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
    setUrlParam("c", info.sites.find((s) => s.primary)?.companyId ?? null);
    dirty = true;
  }

  let down = null;
  const onDown = (e) => {
    if (!(e.target instanceof HTMLCanvasElement)) return;
    down = e.isPrimary ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), multi: false, button: e.button } : down && { ...down, multi: true };
  };
  const onMove = (e) => {
    if (!down || e.pointerId !== down.id || down.multi || down.button !== 0 || !follower?.following) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > PAN_PX) unfollow();
  };
  const onUp = (e) => {
    if (!down || e.pointerId !== down.id) return;
    const d = down;
    down = null;
    if (d.multi || performance.now() - d.t > TAP_MS || Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_PX) return;
    guard(onTap)(e.clientX, e.clientY);
  };
  const onKey = (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === "Escape") { panel.hide(); unfollow(); }
    else if (PAN_KEYS.has(e.key.toLowerCase())) unfollow();
  };
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("keydown", onKey);

  let alive = true;
  let lastSlow = 0;
  const off = city.onFrame(() => {
    if (!alive) return;
    const now = performance.now();
    if (now - lastSlow > 1000) { lastSlow = now; dirty = true; }
    if (dirty) { dirty = false; refresh(); }
    walkers.update();
    labels.update();
    pins.update();
  });

  if (debug) window.__cityUi = { pinScale: (x, y, z) => pinScale(city, x, y, z), flyTo: (companyId) => flyTo(primaryOf(sites, companyId)), panel, labels, pins, live, walkers, follow, unfollow };

  const wanted = params.get("c");
  if (wanted) {
    const site = primaryOf(sites, wanted);
    if (site) flyTo(site);
    else showError(`no company "${wanted}" in this city`);
  }

  function destroy() {
    alive = false;
    if (typeof off === "function") off();
    socket?.close();
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("keydown", onKey);
    walkers.dispose();
    pins.dispose();
    labels.destroy();
    search.destroy();
    ui.remove();
    if (window.__cityUi) delete window.__cityUi;
  }

  return { destroy, live };
}
