// Building panel: every company site in the clicked building (name, address, status, category, verified date,
// sources, height), or "building · N m" when it holds none. No office link in v1 (spec §1).

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

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
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

/** → {show(info), hide(), el} */
export function createPanel(root, { onClose = () => {} } = {}) {
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
  panel.append(head, body);
  root.appendChild(panel);

  function hide() {
    if (panel.hidden) return;
    panel.hidden = true;
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
  }

  return { show, hide, el: panel, get open() { return !panel.hidden; } };
}
