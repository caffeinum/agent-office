// Search box over companies, places (places.json: landmarks, intersections, areas) and walking agents: type, pick,
// fly there (or follow the agent).

export const MAX_RESULTS = 8;

const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Pure, case- and accent-insensitive. Matches the company name or companyId. Ranking: name prefix, then word
 * prefix, then substring; primary sites before others; then company-list order. → sites[]
 */
export function searchSites(sites, query) {
  if (typeof query !== "string") throw new Error("searchSites: query must be a string");
  const q = norm(query);
  if (!q) return [];
  const scored = [];
  sites.forEach((s, order) => {
    const name = norm(s.name), cid = norm(s.companyId);
    let rank;
    if (name.startsWith(q) || cid.startsWith(q)) rank = 0;
    else if (` ${name}`.includes(` ${q}`)) rank = 1;
    else if (name.includes(q) || cid.includes(q)) rank = 2;
    else return;
    scored.push({ s, rank, primary: s.primary ? 0 : 1, order });
  });
  scored.sort((a, b) => a.rank - b.rank || a.primary - b.primary || a.order - b.order);
  return scored.map((x) => x.s);
}

const KIND_ORDER = { company: 0, place: 1, agent: 2 };

function rankOf(q, ...names) {
  let best = null;
  for (const raw of names) {
    const n = norm(raw);
    const r = n.startsWith(q) ? 0 : ` ${n}`.includes(` ${q}`) ? 1 : n.includes(q) ? 2 : null;
    if (r !== null && (best === null || r < best)) best = r;
  }
  return best;
}

/**
 * Pure. Companies (searchSites ranking), places other than company places (name or alias) and walkers (name).
 * Ranked by match (prefix, word prefix, substring), then companies, places, agents. → [{kind, id, name, sub, hue?, color?, item}]
 */
export function searchAll({ sites, places, walkers }, query) {
  if (typeof query !== "string") throw new Error("searchAll: query must be a string");
  const q = norm(query);
  if (!q) return [];
  const out = [];
  const companyRank = new Map(searchSites(sites, query).map((s, i) => [s, i]));
  for (const [s, i] of companyRank) {
    const rank = rankOf(q, s.name, s.companyId);
    out.push({ kind: "company", id: s.id, name: s.name, sub: s.primary ? s.address : `${s.status} · ${s.address}`, color: s.color, item: s, rank, order: i });
  }
  places.forEach((p, i) => {
    if (p.kind === "company") return;
    const rank = rankOf(q, p.name, ...p.aliases);
    if (rank !== null) out.push({ kind: "place", id: p.id, name: p.name, sub: p.kind, item: p, rank, order: i });
  });
  walkers.forEach((w, i) => {
    const rank = rankOf(q, w.name);
    if (rank !== null) out.push({ kind: "agent", id: w.id, name: w.name, sub: `agent · ${w.status}`, hue: w.hue, item: w, rank, order: i });
  });
  out.sort((a, b) => a.rank - b.rank || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.order - b.order);
  return out.map(({ rank, order, ...r }) => r);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** sources() → {sites, places, walkers}; onPick(result) with a searchAll result. → {destroy(), input} */
export function createSearch(root, sources, onPick) {
  const box = el("div", "cu-search cu-glass");
  const input = el("input", "cu-search-input");
  input.type = "search";
  input.placeholder = "search companies, places, agents";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "search companies, places and agents");
  const list = el("ul", "cu-results");
  list.setAttribute("role", "listbox");
  list.hidden = true;
  box.append(input, list);
  root.appendChild(box);

  let results = [], active = 0;

  function render() {
    list.replaceChildren(...results.map((r, i) => {
      const li = el("li", `cu-result ${r.kind}${i === active ? " on" : ""}${r.item.status === "former" ? " former" : ""}`);
      li.setAttribute("role", "option");
      if (r.kind === "company") li.style.setProperty("--c", r.color);
      if (r.kind === "agent") li.style.setProperty("--h", String(((r.hue % 360) + 360) % 360));
      li.append(el("i", r.kind === "agent" ? "cu-hue" : "cu-sw"), el("b", "", r.name), el("small", "", r.sub));
      li.addEventListener("pointerdown", (e) => { e.preventDefault(); pick(i); });
      return li;
    }));
    if (input.value.trim() && !results.length) list.replaceChildren(el("li", "cu-result none", "nothing matches"));
    list.hidden = !input.value.trim();
  }

  function pick(i) {
    const s = results[i];
    if (!s) return;
    input.value = s.name;
    list.hidden = true;
    input.blur();
    onPick(s);
  }

  function onInput() {
    results = searchAll(sources(), input.value).slice(0, MAX_RESULTS);
    active = 0;
    render();
  }

  function onKey(e) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape") {
      input.value = "";
      onInput();
      input.blur();
    }
    e.stopPropagation();
  }

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKey);
  input.addEventListener("keyup", (e) => e.stopPropagation());
  input.addEventListener("focus", () => { if (input.value.trim()) onInput(); });
  input.addEventListener("blur", () => { list.hidden = true; });

  return { destroy: () => box.remove(), input };
}
