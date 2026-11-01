// DOM label chips beside the roof (roofY + 2) of each company's primary site, so a chip never covers a tower's crown.
// Companies sharing a building share one chip (one row each), so a shared tower never hides a name. Former
// companies are not labelled (search still finds them). At most labelBudget(viewport) chips (≤ 24), culled by
// distance from the camera, then by overlap with a LABEL_GAP margin, nearest the screen centre first.

export const MAX_LABELS = 24;
export const LABEL_LIFT = 2;
/** Screen px kept clear between chips. */
export const LABEL_GAP = 6;
/** A chip beside its anchor: this far right of it, the chip's tail pointing back. */
export const LABEL_SIDE = 10;
/** Viewport px² per chip: the budget scales with the screen, so a phone shows few. */
export const LABEL_AREA_PX = 60000;
/** Chips whose anchor is farther from the camera than this × the orbit distance are dropped. */
export const LABEL_FAR = 2.2;

/** Pure. How many chips a vw × vh viewport shows: one per LABEL_AREA_PX, 4..MAX_LABELS. */
export function labelBudget(vw, vh) {
  if (!(vw >= 0) || !(vh >= 0)) throw new Error(`labelBudget: bad viewport ${vw}×${vh}`);
  return Math.max(4, Math.min(MAX_LABELS, Math.round((vw * vh) / LABEL_AREA_PX)));
}

const NUM_FIELDS = ["x", "y", "w", "h", "dist", "order"];

/**
 * Pure. candidates = [{id, x, y, w, h, dist, order}] in screen px (x, y = top-left). Greedy: nearest first, list
 * order breaks ties; a candidate overlapping an already-kept one is dropped. → kept candidates (≤ max).
 */
export function cullLabels(candidates, max = MAX_LABELS, gap = 0) {
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
    const hit = kept.some((k) => r.x < k.x + k.w + gap && r.x + r.w + gap > k.x && r.y < k.y + k.h + gap && r.y + r.h + gap > k.y);
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
export function createLabels(city, sites, root, { onPick = () => {}, showFormer = false } = {}) {
  const layer = el("div", "cu-labels");
  root.appendChild(layer);
  const shown = showFormer ? sites : sites.filter((s) => s.status !== "former");
  const groups = labelGroups(shown).map((g) => {
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
    const cam = city.camera.position;
    const far = LABEL_FAR * city.cameraDistance();
    const candidates = [];
    for (const g of groups) {
      const p = city.worldToScreen(g.x, g.y, g.z);
      const away = Math.hypot(g.x - cam.x, g.y - cam.y, g.z - cam.z);
      if (!p.visible || away > far || p.x < -200 || p.y < -100 || p.x > vw + 200 || p.y > vh + 100) {
        g.chip.hidden = true;
        continue;
      }
      if (!g.size) {
        g.chip.hidden = false;
        g.size = { w: g.chip.offsetWidth, h: g.chip.offsetHeight };
      }
      g.screen = p;
      candidates.push({ id: g.key, x: p.x + LABEL_SIDE, y: p.y - g.size.h / 2, w: g.size.w, h: g.size.h, dist: Math.hypot(p.x - cx, p.y - cy), order: g.order, g });
    }
    const kept = new Set(cullLabels(candidates, labelBudget(vw, vh), LABEL_GAP).map((c) => c.g));
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
