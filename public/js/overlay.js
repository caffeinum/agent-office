// DOM overlay projected over the canvas: one name pill per agent (emoji, name, status dot, activity
// while working) and a speech bubble while it `says` something. Overlapping pills are culled by
// priority (selected > speaking > waiting > working > idle > away).

import { activeSay, clip, cullLabels, hueColors, labelPriority } from "./model.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function createOverlay(layer, { onClick }) {
  const nodes = new Map();
  let agents = new Map();
  let selected = null;

  function render(a, n) {
    const say = activeSay(a);
    const sig = `${a.name}|${a.emoji}|${a.status}|${a.activity}|${say}|${a.hue}|${selected === a.id}`;
    if (n.sig === sig) return;
    n.sig = sig;
    const col = hueColors(a.hue ?? 0).css;
    const act = a.status === "working" && a.activity ? `<div class="act">${esc(clip(a.activity, 48))}</div>` : a.status === "waiting" ? `<div class="act wait">${esc(clip(a.activity || "needs input", 48))}</div>` : "";
    n.el.innerHTML = `${say ? `<div class="bubble">${esc(clip(say, 140))}</div>` : ""}<div class="tag" style="--hue:${col}">${a.emoji ? `<span class="emo">${esc(a.emoji)}</span>` : ""}<b>${esc(a.name)}</b><i class="dot ${a.status}"></i></div>${act}`;
    n.el.classList.toggle("away", a.status === "away");
    n.el.classList.toggle("working", a.status === "working");
    n.el.classList.toggle("sel", selected === a.id);
    n.el.classList.toggle("speaking", !!say);
    n.size = null;
  }

  function setAgents(list) {
    agents = new Map(list.map((a) => [a.id, a]));
    for (const a of list) {
      let n = nodes.get(a.id);
      if (!n) {
        const el = document.createElement("div");
        el.className = "pill";
        el.addEventListener("click", () => onClick(a.id));
        layer.appendChild(el);
        n = { el, sig: "", size: null };
        nodes.set(a.id, n);
      }
      render(a, n);
    }
  }

  function setSelected(id) {
    selected = id;
    for (const [aid, n] of nodes) { const a = agents.get(aid); if (a) render(a, n); }
  }

  /** Called every frame with the scene's anchors. */
  function update(anchors) {
    const rects = [];
    const live = new Set();
    for (const p of anchors) {
      const n = nodes.get(p.id);
      if (!n) continue;
      live.add(p.id);
      const a = agents.get(p.id);
      if (a) render(a, n); // bubbles expire with time, so re-check (cheap: signature compare)
      if (!p.visible || p.scale < 0.2) { n.el.style.display = "none"; continue; }
      n.el.style.display = "";
      if (!n.size) n.size = { w: n.el.offsetWidth, h: n.el.offsetHeight };
      // Sub-pixel noise from camera damping and pose blending made labels shimmer: ignore moves under
      // a pixel, ease small ones, follow big ones (orbit, zoom) at once.
      const dx = p.x - (n.sx ?? p.x), dy = p.y - (n.sy ?? p.y), d = Math.hypot(dx, dy);
      if (n.sx === undefined || d > 24) { n.sx = p.x; n.sy = p.y; }
      else if (d > 0.75) { n.sx += dx * 0.5; n.sy += dy * 0.5; }
      const x = n.sx - n.size.w / 2, y = n.sy - n.size.h;
      // Hysteresis: a label already shown outranks an equal-priority neighbour, so overlaps don't flip every frame.
      const priority = labelPriority({ selected: selected === p.id, status: a?.status, speaking: n.el.classList.contains("speaking") }) + (n.kept ? 5 : 0);
      rects.push({ id: p.id, x, y, w: n.size.w, h: n.size.h, depth: p.depth, priority });
      n.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      const z = String(1000 - Math.round(p.depth * 10));
      if (n.el.style.zIndex !== z) n.el.style.zIndex = z;
    }
    const keep = cullLabels(rects);
    for (const r of rects) { const n = nodes.get(r.id); n.kept = keep.has(r.id); n.el.classList.toggle("culled", !n.kept); }
    for (const [id, n] of nodes) {
      if (!live.has(id)) { n.el.remove(); nodes.delete(id); }
    }
  }

  return { setAgents, setSelected, update };
}
