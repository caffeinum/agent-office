// Building panel: every company site in the clicked building (name, address, status, category, verified date,
// sources, height), or "building · N m" when it holds none, plus "here now" (spec-v2 §7.5): the office agents
// bridged to those companies, walkers gone inside, and walkers standing at the door. Also the people list (every
// walker, tap to follow) with the city chat tail. All names and chat go through textContent only.

import { BLOCK_M } from "../../shared/city.js";

/** Pure. building = {id, base, top}. → {buildingId, heightM, sites} with sites in company-list order. */
export function buildingInfo(sites, building) {
  if (!building || !Number.isInteger(building.id)) throw new Error(`buildingInfo: bad building ${JSON.stringify(building)}`);
  if (!Number.isInteger(building.base) || !Number.isInteger(building.top) || building.top <= building.base) {
    throw new Error(`buildingInfo: building ${building.id} has bad base/top ${building.base}/${building.top}`);
  }
  return {
    buildingId: building.id,
    heightM: (building.top - building.base) * BLOCK_M,
    sites: sites.filter((s) => s.buildingId === building.id),
  };
}

/** Pure. Panel info for a company site without touching chunks (works before its chunk loads). */
export function siteInfo(sites, site) {
  return { buildingId: site.buildingId, heightM: site.heightM, sites: sites.filter((s) => s.buildingId === site.buildingId) };
}

/** Pure. → "2 companies · 300 m", or "building · 300 m" when the building holds none. */
export function panelTitle(info) {
  return info.sites.length ? `${info.sites.length === 1 ? "1 company" : `${info.sites.length} companies`} · ${info.heightM} m` : `building · ${info.heightM} m`;
}

/** Walkers within this many blocks of a site's anchor count as "at the door". */
export const NEAR_SITE = 8;
export const CHAT_SHOWN = 8;
const WHERE_ORDER = { office: 0, inside: 1, outside: 2 };

/**
 * Pure. Who is at the companies of a panel `info`: presence agents ("office"), walkers inside one of its sites
 * ("inside") and walkers within NEAR_SITE of a site anchor ("outside"). positionOf(id) → {x, z} | null.
 * → [{key, name, hue, status, where, companyId, walkerId?}]
 */
export function whoIsHere(info, { presence, walkers, positionOf }) {
  const companies = new Set(info.sites.map((s) => s.companyId));
  const siteIds = new Set(info.sites.map((s) => s.id));
  const rows = [];
  for (const p of presence) {
    if (!companies.has(p.companyId)) continue;
    for (const a of p.agents) rows.push({ key: `o:${p.companyId}:${a.name}`, name: a.name, hue: a.hue, status: a.status, where: "office", companyId: p.companyId });
  }
  for (const w of walkers) {
    if (w.inside) {
      if (!siteIds.has(w.siteId)) continue;
      const site = info.sites.find((s) => s.id === w.siteId);
      rows.push({ key: `w:${w.id}`, name: w.name, hue: w.hue, status: w.status, where: "inside", companyId: site.companyId, walkerId: w.id });
      continue;
    }
    const pos = positionOf(w.id);
    if (!pos) throw new Error(`whoIsHere: walker ${w.id} has no position`);
    const at = info.sites.find((s) => Math.hypot(pos.x - (s.anchor.x + 0.5), pos.z - (s.anchor.z + 0.5)) <= NEAR_SITE);
    if (at) rows.push({ key: `w:${w.id}`, name: w.name, hue: w.hue, status: w.status, where: "outside", companyId: at.companyId, walkerId: w.id });
  }
  return rows.sort((a, b) => WHERE_ORDER[a.where] - WHERE_ORDER[b.where] || a.name.localeCompare(b.name));
}

/** Pure. A walker's one-word activity for the people list. */
export function walkerActivity(w, pos) {
  if (w.inside) return "inside";
  if (!pos?.moving) return "here";
  return w.mode === "ride" ? "riding" : "walking";
}

function el(tag, cls, text, doc = document) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const hueOf = (h) => String(((h % 360) + 360) % 360);

/** One chat line, text only: a URL or markup in the text stays literal (never linkified, never parsed). */
export function chatLine(c, doc = document) {
  const li = el("li", `cu-chat-line ${c.scope}`, undefined, doc);
  const name = el("b", "", c.name, doc);
  const text = el("span", "", c.text, doc);
  const scope = el("small", "", c.scope === "city" ? "city" : "near", doc);
  li.append(name, text, scope);
  return li;
}

/** One person row (hue dot, name, status, where) — a button when it is a walker that can be followed. */
export function personRow(p, onFollow, doc = document) {
  const row = el(p.walkerId ? "button" : "div", `cu-person ${p.where ?? ""}`, undefined, doc);
  if (p.walkerId) {
    row.type = "button";
    row.title = `follow ${p.name}`;
    row.addEventListener("click", () => onFollow(p.walkerId));
  }
  row.style.setProperty("--h", hueOf(p.hue));
  row.append(el("i", "cu-hue", undefined, doc), el("b", "", p.name, doc), el("span", "cu-pstatus", p.status, doc));
  if (p.where) row.append(el("small", "", p.where === "office" ? "in office" : p.where, doc));
  return row;
}

function sourceLink(src, siteId) {
  if (src.kind === "operator") {
    const chip = el("span", "cu-src");
    chip.title = src.statement;
    chip.append(el("span", "cu-src-kind", "operator"), el("span", "cu-src-host", "operator statement"), el("time", "", src.date));
    return chip;
  }
  let url;
  try { url = new URL(src.url); } catch { throw new Error(`panel: site ${siteId} has an unparseable source url ${JSON.stringify(src.url)}`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`panel: site ${siteId} source ${src.url} is not http(s)`);
  const a = el("a", "cu-src");
  a.href = url.href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.append(el("span", "cu-src-kind", src.kind), el("span", "cu-src-host", url.hostname.replace(/^www\./, "")));
  if (src.date) a.append(el("time", "", src.date));
  else if (src.accessed) a.append(el("time", "", `read ${src.accessed}`));
  return a;
}

function siteCard(s) {
  const card = el("article", `cu-site${s.status === "former" ? " former" : ""}`);
  card.style.setProperty("--c", s.color);
  const head = el("header");
  head.append(el("i", "cu-sw"), el("b", "", s.name), el("span", `cu-status ${s.status}`, s.status));
  card.append(head);
  card.append(el("p", "cu-addr", s.address));
  const meta = el("p", "cu-meta");
  meta.append(el("span", "", s.category), el("span", "", `verified ${s.verifiedAt}`));
  if (s.placement === "nearest") meta.append(el("span", "", `nearest building, ${s.placementDistM} m`));
  if (s.placement === "override") meta.append(el("span", "", `placed by override, ${s.placementDistM} m from the address point`));
  card.append(meta);
  if (s.note) card.append(el("p", "cu-note", s.note));
  const srcs = el("div", "cu-srcs");
  for (const src of s.sources) srcs.append(sourceLink(src, s.id));
  card.append(srcs);
  return card;
}

/** → {show(info), setPeople(rows), hide(), el, open, info} */
export function createPanel(root, { onClose = () => {}, onFollow = () => {} } = {}) {
  const panel = el("aside", "cu-panel cu-glass");
  panel.hidden = true;
  panel.setAttribute("aria-live", "polite");
  const head = el("div", "cu-panel-head");
  const title = el("h2", "cu-panel-title");
  const close = el("button", "cu-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "close");
  head.append(title, close);
  const body = el("div", "cu-panel-body");
  const here = el("section", "cu-here");
  here.hidden = true;
  const hereTitle = el("h3", "", "here now");
  const hereList = el("div", "cu-here-list");
  here.append(hereTitle, hereList);
  panel.append(head, here, body);
  let current = null;
  root.appendChild(panel);

  function hide() {
    if (panel.hidden) return;
    panel.hidden = true;
    current = null;
    onClose();
  }
  close.addEventListener("click", hide);

  function show(info) {
    const cards = info.sites.map(siteCard);
    title.textContent = panelTitle(info);
    body.replaceChildren(...cards);
    panel.dataset.building = String(info.buildingId);
    panel.classList.toggle("empty", cards.length === 0);
    panel.hidden = false;
    current = info;
  }

  function setPeople(rows) {
    hereTitle.textContent = `here now · ${rows.length}`;
    hereList.replaceChildren(...rows.map((p) => personRow(p, onFollow)));
    here.hidden = rows.length === 0;
  }

  return { show, setPeople, hide, el: panel, get open() { return !panel.hidden; }, get info() { return current; } };
}

/**
 * The people list: live status, every walker (tap to follow) and the last CHAT_SHOWN city chat lines.
 * render({walkers, positionOf, chat, selected}) and setStatus(status, detail). → {render, setStatus, el}
 */
export function createPeople(root, { onFollow = () => {} } = {}) {
  const box = el("aside", "cu-people cu-glass");
  const head = el("button", "cu-people-head");
  head.type = "button";
  head.setAttribute("aria-expanded", "false");
  const dot = el("i", "cu-live-dot");
  const title = el("b", "", "people");
  const status = el("small", "cu-live", "connecting");
  head.append(dot, title, status);
  const body = el("div", "cu-people-body");
  body.hidden = true;
  const list = el("div", "cu-people-list");
  const chatList = el("ul", "cu-chat");
  body.append(list, chatList);
  box.append(head, body);
  root.appendChild(box);
  head.addEventListener("click", () => {
    body.hidden = !body.hidden;
    head.setAttribute("aria-expanded", String(!body.hidden));
  });

  function render({ walkers, positionOf, chat, selected }) {
    title.textContent = `people · ${walkers.length}`;
    const rows = [...walkers].sort((a, b) => a.name.localeCompare(b.name)).map((w) => {
      const row = personRow({ name: w.name, hue: w.hue, status: w.status, where: walkerActivity(w, positionOf(w.id)), walkerId: w.id }, onFollow);
      row.classList.toggle("on", w.id === selected);
      return row;
    });
    list.replaceChildren(...(rows.length ? rows : [el("p", "cu-empty", "nobody is walking the city right now")]));
    chatList.replaceChildren(...chat.slice(-CHAT_SHOWN).map((c) => chatLine(c)));
  }

  function setStatus(s, detail) {
    box.dataset.live = s;
    status.textContent = s === "offline" && detail?.retryMs ? `offline · retry in ${Math.round(detail.retryMs / 1000)} s` : s;
  }

  return { render, setStatus, el: box };
}
