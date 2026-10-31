// Canvas editing for the owner: palette of kinds → ghost preview snapped to the grid (red when the
// catalog says no) → click to place; click an item → rotate / move / text / colour / delete. Every edit
// is sent as {type:'op'}; the office answers with item deltas (or an error frame).

import { KIND_NAMES, ROTS, TEXT_MAX, kindOf, validateItem } from "../shared/catalog.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const SWATCHES = ["#e0614f", "#f2a65a", "#f2c879", "#7cc47a", "#6aa6c9", "#6f9fc0", "#b77ad6", "#f28aa6", "#f3ede2", "#3a4a3f"];

/** Where a kind lands for a floor point: wall kinds snap to the nearest wall they can hang on. */
export function placementFor(kind, p, rot, custom) {
  const k = kindOf(kind, custom);
  if (!k) throw new Error(`unknown kind ${JSON.stringify(kind)}`);
  if (k.layer === "wall") {
    const toBack = p.z, toLeft = p.x;
    if (toLeft < toBack) return { kind, rot: 90, x: 0, z: Math.round(p.z - k.w / 2) };
    return { kind, rot: 0, x: Math.round(p.x - k.w / 2), z: 0 };
  }
  const turned = rot === 90 || rot === 270;
  const w = turned ? k.d : k.w, d = turned ? k.w : k.d;
  return { kind, rot, x: Math.round(p.x - w / 2), z: Math.round(p.z - d / 2) };
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const imageIn = (dt) => [...(dt?.files ?? [])].find((f) => IMAGE_TYPES.includes(f.type)) ?? null;

export function createEditor(root, { scene, send, getState, toast, uploadLogo, setLogo }) {
  root.insertAdjacentHTML("beforeend", `
    <div class="palette glass" hidden>
      <div class="pal-head"><b>Furniture</b><span>click a piece, then the floor · <kbd>R</kbd> rotate · <kbd>Esc</kbd> cancel</span></div>
      <div class="pal-grid"></div>
      <div class="pal-logo" tabindex="0" title="drop, paste or pick a PNG / JPG / WebP (≤512 KB, ≤1024 px)">
        <span class="lg-img"></span><span class="lg-txt"><b>Logo</b><small>drop or paste an image · it goes on the TV and every screen</small></span>
        <label class="lg-pick">choose…<input type="file" accept="image/png,image/jpeg,image/webp" hidden></label>
        <button class="lg-clear" hidden title="remove the logo">×</button>
      </div>
      <div class="pal-sw"><span>colour</span><button data-color="" class="on" title="the piece's own colour">auto</button>${SWATCHES.map((c) => `<button data-color="${c}" style="background:${c}" title="${c}"></button>`).join("")}</div>
    </div>
    <div class="itembar glass" hidden></div>
    <div class="ghosttip" hidden></div>`);
  const palette = root.querySelector(".palette"), bar = root.querySelector(".itembar"), tip = root.querySelector(".ghosttip");
  let on = false, mode = null; // mode: {type:'place', kind, rot} | {type:'move', item} | null
  let selected = null, lastPointer = null, pendingColor = null;
  // thumbnails are cached per kind definition, so a redefined custom kind gets a fresh one
  const thumbCache = new Map();
  let paletteSig = "";
  const custom = () => getState()?.customKinds ?? {};
  const thumbFor = (name, def) => {
    const hit = thumbCache.get(name);
    if (hit && hit.def === def) return hit.url;
    const url = scene.thumbnail(name);
    thumbCache.set(name, { def, url });
    return url;
  };

  const logoRow = palette.querySelector(".pal-logo");
  const takeLogo = (f) => { if (f) uploadLogo(f); };
  logoRow.querySelector("input").addEventListener("change", (e) => { takeLogo(e.target.files[0]); e.target.value = ""; });
  logoRow.querySelector(".lg-clear").addEventListener("click", () => setLogo(null));
  logoRow.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types ?? [])].includes("Files")) { e.preventDefault(); logoRow.classList.add("drop"); } });
  logoRow.addEventListener("dragleave", () => logoRow.classList.remove("drop"));
  logoRow.addEventListener("drop", (e) => { logoRow.classList.remove("drop"); const f = imageIn(e.dataTransfer); if (f) { e.preventDefault(); takeLogo(f); } });
  // paste anywhere while the edit panel is open (and focus isn't in a text box) sets the logo
  window.addEventListener("paste", (e) => {
    if (!on || e.target.closest?.("input, textarea")) return;
    const f = imageIn(e.clipboardData);
    if (f) { e.preventDefault(); takeLogo(f); }
  });

  function syncLogoRow(state) {
    const id = state.theme?.logo ?? null;
    const asset = id ? state.assets.find((a) => a.id === id) : null;
    const img = logoRow.querySelector(".lg-img");
    const want = asset ? asset.url : "";
    if (img.dataset.src !== want) { img.dataset.src = want; img.style.backgroundImage = want ? `url("${want}")` : ""; }
    logoRow.classList.toggle("has", !!asset);
    logoRow.querySelector(".lg-clear").hidden = !asset;
  }

  function fillPalette() {
    const cust = custom();
    const names = [...KIND_NAMES, ...Object.keys(cust).sort()];
    const fresh = names.join("|") === paletteSig && Object.values(cust).every((d) => thumbCache.get(d.kind)?.def === d);
    if (fresh && palette.querySelector(".kind")) return;
    paletteSig = names.join("|");
    const btn = (k, def, extra = "") => `
      <button class="kind ${extra}${mode?.type === "place" && mode.kind === k ? " on" : ""}" data-kind="${esc(k)}" title="${esc(def.label)} (${def.w}×${def.d})${def.custom ? ` · custom${def.by ? ` by ${esc(def.by)}` : ""}` : ""}">
        <img alt="" src="${thumbFor(k, def)}"><span>${esc(def.label)}</span>
      </button>`;
    const customNames = Object.keys(cust).sort();
    palette.querySelector(".pal-grid").innerHTML = KIND_NAMES.map((k) => btn(k, kindOf(k))).join("")
      + (customNames.length ? `<div class="pal-sep">made for this office</div>${customNames.map((k) => btn(k, cust[k], "custom")).join("")}` : "");
    for (const k of thumbCache.keys()) if (!KIND_NAMES.includes(k) && !cust[k]) thumbCache.delete(k);
  }
  palette.addEventListener("click", (e) => {
    const sw = e.target.closest("[data-color]");
    if (sw) {
      pendingColor = sw.dataset.color || null;
      palette.querySelectorAll("[data-color]").forEach((x) => x.classList.toggle("on", x === sw));
      return;
    }
    const b = e.target.closest(".kind");
    if (!b) return;
    select(null);
    mode = mode?.type === "place" && mode.kind === b.dataset.kind ? null : { type: "place", kind: b.dataset.kind, rot: 0 };
    palette.querySelectorAll(".kind").forEach((x) => x.classList.toggle("on", mode?.type === "place" && x.dataset.kind === mode.kind));
    refreshGhost();
  });

  function candidate() {
    if (!mode || !lastPointer) return null;
    const st = getState();
    const p = scene.floorAt(lastPointer.x, lastPointer.y);
    if (!p) return null;
    const kind = mode.type === "place" ? mode.kind : mode.item.kind;
    const rot = mode.type === "place" ? mode.rot : mode.item.rot;
    const c = placementFor(kind, p, rot, st.customKinds);
    const others = mode.type === "move" ? st.items.filter((i) => i.id !== mode.item.id) : st.items;
    let error = null;
    try {
      validateItem({ id: mode.type === "move" ? mode.item.id : "ghost", kind: c.kind, x: c.x, z: c.z, rot: c.rot, by: "ghost", at: 0 }, others, st.grid, st.customKinds);
    } catch (e) {
      error = e.message;
    }
    return { ...c, valid: !error, error };
  }

  function refreshGhost() {
    const c = candidate();
    scene.setGhost(c);
    if (c && !c.valid && lastPointer) {
      tip.hidden = false;
      tip.textContent = c.error;
      tip.style.transform = `translate(${lastPointer.x + 14}px, ${lastPointer.y + 14}px)`;
    } else tip.hidden = true;
  }

  function select(item) {
    selected = item;
    scene.selectItem(item);
    if (!item) { bar.hidden = true; return; }
    const k = kindOf(item.kind, custom());
    if (!k) { select(null); return; }
    bar.innerHTML = `
      <div class="ib-head"><b>${esc(k.label)}</b><small>${esc(item.id)} · by ${esc(item.by)}</small></div>
      <div class="ib-row">
        <button data-a="rotate" title="rotate 90°">⟳ rotate</button>
        <button data-a="move" title="move">✥ move</button>
        <button data-a="remove" class="danger" title="remove">🗑 remove</button>
      </div>
      ${k.textable ? `<form class="ib-text"><input maxlength="${TEXT_MAX}" value="${esc(item.text ?? "")}" placeholder="text on the ${esc(k.label)}"><button>set</button></form>` : ""}`;
    bar.hidden = false;
    const form = bar.querySelector(".ib-text");
    if (form) form.addEventListener("submit", (e) => { e.preventDefault(); op({ op: "text", id: item.id, text: form.querySelector("input").value }); });
  }

  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !selected) return;
    const st = getState();
    if (b.dataset.a === "rotate") {
      const rot = ROTS[(ROTS.indexOf(selected.rot) + 1) % 4];
      try {
        validateItem({ ...selected, rot }, st.items.filter((i) => i.id !== selected.id), st.grid, st.customKinds);
      } catch (err) { toast(`Can't rotate here: ${err.message}`, "err"); return; }
      op({ op: "rotate", id: selected.id, rot });
    } else if (b.dataset.a === "move") {
      mode = { type: "move", item: selected };
      scene.hideItems([selected.id]);
      bar.hidden = true;
      refreshGhost();
    } else if (b.dataset.a === "remove") {
      op({ op: "remove", id: selected.id });
      select(null);
    }
  });

  function op(o) {
    try {
      send({ type: "op", op: o });
    } catch (err) {
      toast(err.message, "err");
    }
  }

  function cancel() {
    if (mode?.type === "move") scene.hideItems([]);
    mode = null;
    palette.querySelectorAll(".kind").forEach((x) => x.classList.remove("on"));
    scene.setGhost(null);
    tip.hidden = true;
  }

  /** Returns true if the editor consumed the click. */
  function click(x, y) {
    if (!on) return false;
    lastPointer = { x, y };
    if (mode) {
      const c = candidate();
      if (!c) return true;
      if (!c.valid) { toast(c.error, "err"); return true; }
      if (mode.type === "place") {
        const o = { op: "add", kind: c.kind, x: c.x, z: c.z, rot: c.rot };
        const def = kindOf(c.kind, custom());
        if (def.textable) o.text = def.label;
        if (pendingColor) o.color = pendingColor;
        op(o);
      } else {
        op({ op: "move", id: mode.item.id, x: c.x, z: c.z });
        scene.hideItems([]);
        mode = null;
        scene.setGhost(null);
      }
      return true;
    }
    const hit = scene.pickAt(x, y, { agents: false });
    if (hit?.type === "item") select(getState().items.find((i) => i.id === hit.id) ?? null);
    else select(null);
    return true;
  }

  function move(x, y) {
    lastPointer = { x, y };
    if (on && mode) refreshGhost();
  }

  function key(e) {
    if (!on) return;
    if (e.target.closest?.("input, textarea")) return;
    if (e.key === "Escape") { if (mode) cancel(); else select(null); }
    if ((e.key === "r" || e.key === "R") && mode?.type === "place") { mode.rot = ROTS[(ROTS.indexOf(mode.rot) + 1) % 4]; refreshGhost(); }
    if ((e.key === "Delete" || e.key === "Backspace") && selected && !mode) { op({ op: "remove", id: selected.id }); select(null); }
  }
  window.addEventListener("keydown", key);

  return {
    get on() { return on; },
    toggle(force) {
      on = force ?? !on;
      palette.hidden = !on;
      if (on) { fillPalette(); syncLogoRow(getState()); }
      else { cancel(); select(null); }
      return on;
    },
    click, move,
    /** Keep the selection pointing at the live item after deltas. */
    sync(state) {
      if (selected) {
        const it = state.items.find((i) => i.id === selected.id);
        if (!it) select(null);
        else if (it !== selected) select(it);
      }
      if (mode?.type === "move" && !state.items.some((i) => i.id === mode.item.id)) cancel();
      if (mode?.type === "place" && !kindOf(mode.kind, state.customKinds)) cancel();
      if (on) { fillPalette(); syncLogoRow(state); }
      if (mode) refreshGhost();
    },
  };
}
