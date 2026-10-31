// DOM label chips at roofY + 2 above each company's primary site. Companies sharing a building share one chip
// (one row each), so a shared tower never hides a name. ≤ 24 chips visible, culled by overlap then distance.

export const MAX_LABELS = 24;
export const LABEL_LIFT = 2;

const NUM_FIELDS = ["x", "y", "w", "h", "dist", "order"];

/**
 * Pure. candidates = [{id, x, y, w, h, dist, order}] in screen px (x, y = top-left). Greedy: nearest first, list
 * order breaks ties; a candidate overlapping an already-kept one is dropped. → kept candidates (≤ max).
 */
export function cullLabels(candidates, max = MAX_LABELS) {
  if (!Array.isArray(candidates)) throw new Error("cullLabels: candidates must be an array");
  if (!Number.isInteger(max) || max < 0) throw new Error(`cullLabels: max must be an integer ≥ 0, got ${max}`);
  for (const c of candidates) {
    for (const k of NUM_FIELDS) {
      if (!Number.isFinite(c?.[k])) throw new Error(`cullLabels: candidate ${JSON.stringify(c?.id)} has no numeric ${k}`);
    }
  }
  const sorted = [...candidates].sort((a, b) => a.dist - b.dist || a.order - b.order);
  const kept = [];
  for (const r of sorted) {
    if (kept.length >= max) break;
    const hit = kept.some((k) => r.x < k.x + k.w && r.x + r.w > k.x && r.y < k.y + k.h && r.y + r.h > k.y);
    if (!hit) kept.push(r);
  }
  return kept;
}

/**
 * Pure. One label group per building that holds at least one primary site, in company-list order.
 * → [{key, buildingId, order, x, y, z, sites}] where (x, y, z) is the chip anchor in blocks.
 */
export function labelGroups(sites) {
  const groups = new Map();
  sites.forEach((s, order) => {
    if (!s.primary) return;
    let g = groups.get(s.buildingId);
    if (!g) {
      g = { key: `b${s.buildingId}`, buildingId: s.buildingId, order, x: s.block.x + 0.5, y: s.roofY + LABEL_LIFT, z: s.block.z + 0.5, sites: [] };
      groups.set(s.buildingId, g);
    }
    if (s.roofY + LABEL_LIFT > g.y) g.y = s.roofY + LABEL_LIFT;
    g.sites.push(s);
  });
  return [...groups.values()];
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * → {update(), setBadges(Map<companyId, {agents, overflow, pinsVisible}>), destroy()}.
 * onPick(group) fires when a chip is clicked.
 */
export function createLabels(city, sites, root, { onPick = () => {} } = {}) {
  const layer = el("div", "cu-labels");
  root.appendChild(layer);
  const groups = labelGroups(sites).map((g) => {
    const chip = el("button", "cu-chip");
    chip.type = "button";
    chip.hidden = true;
    const rows = new Map();
    for (const s of g.sites) {
      const row = el("span", `cu-chip-row${s.status === "former" ? " former" : ""}`);
      row.style.setProperty("--c", s.color);
      row.append(el("i", "cu-sw"), el("b", "", s.name));
      if (s.status === "former") row.append(el("small", "", "former"));
      const badge = el("span", "cu-badge");
      badge.hidden = true;
      row.append(badge);
      chip.append(row);
      rows.set(s.companyId, badge);
    }
    chip.title = g.sites.map((s) => s.name).join(", ");
    chip.addEventListener("click", () => onPick(g));
    layer.appendChild(chip);
    return { ...g, chip, rows, size: null };
  });

  function update() {
    const vw = layer.clientWidth, vh = layer.clientHeight;
    const cx = vw / 2, cy = vh / 2;
    const candidates = [];
    for (const g of groups) {
      const p = city.worldToScreen(g.x, g.y, g.z);
      if (!p.visible || p.x < -200 || p.y < -100 || p.x > vw + 200 || p.y > vh + 100) {
        g.chip.hidden = true;
        continue;
      }
      if (!g.size) {
        g.chip.hidden = false;
        g.size = { w: g.chip.offsetWidth, h: g.chip.offsetHeight };
      }
      g.screen = p;
      candidates.push({ id: g.key, x: p.x - g.size.w / 2, y: p.y - g.size.h, w: g.size.w, h: g.size.h, dist: Math.hypot(p.x - cx, p.y - cy), order: g.order, g });
    }
    const kept = new Set(cullLabels(candidates).map((c) => c.g));
    for (const c of candidates) {
      const { g } = c;
      g.chip.hidden = !kept.has(g);
      if (!g.chip.hidden) g.chip.style.transform = `translate(${Math.round(c.x)}px, ${Math.round(c.y)}px)`;
    }
  }

  function setBadges(counts) {
    for (const g of groups) {
      for (const [companyId, badge] of g.rows) {
        const c = counts.get(companyId);
        const text = !c || c.agents === 0 ? "" : c.pinsVisible ? (c.overflow > 0 ? `+${c.overflow}` : "") : `${c.agents} agent${c.agents === 1 ? "" : "s"}`;
        badge.hidden = text === "";
        badge.textContent = text;
      }
      g.size = null;
    }
  }

  function destroy() {
    layer.remove();
  }

  return { update, setBadges, destroy, groups };
}
