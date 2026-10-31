// Company search box: type a name, pick a result, fly there.

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

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** → {destroy(), input} */
export function createSearch(root, sites, onPick) {
  const box = el("div", "cu-search cu-glass");
  const input = el("input", "cu-search-input");
  input.type = "search";
  input.placeholder = "search companies";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("aria-label", "search companies");
  const list = el("ul", "cu-results");
  list.setAttribute("role", "listbox");
  list.hidden = true;
  box.append(input, list);
  root.appendChild(box);

  let results = [], active = 0;

  function render() {
    list.replaceChildren(...results.map((s, i) => {
      const li = el("li", `cu-result${i === active ? " on" : ""}${s.status === "former" ? " former" : ""}`);
      li.setAttribute("role", "option");
      li.style.setProperty("--c", s.color);
      li.append(el("i", "cu-sw"), el("b", "", s.name), el("small", "", s.primary ? s.address : `${s.status} · ${s.address}`));
      li.addEventListener("pointerdown", (e) => { e.preventDefault(); pick(i); });
      return li;
    }));
    if (input.value.trim() && !results.length) list.replaceChildren(el("li", "cu-result none", "no company matches"));
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
    results = searchSites(sites, input.value).slice(0, MAX_RESULTS);
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
