// Entry: route (/ = landing, /o/:office = the office), connect the data source, and wire the scene,
// overlay, sidebar and editor together. State only ever changes through applyFrame().

import { applyFrame } from "./model.js";
import { kindOf } from "../shared/catalog.js";
import { createScene } from "./scene.js";
import { createOverlay } from "./overlay.js";
import { createUi } from "./ui.js";
import { createEditor } from "./editor.js";
import { connectDemo, connectLive } from "./source.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const params = new URLSearchParams(location.search);
const demo = params.get("demo") === "1";
const officeMatch = /^\/o\/([^/]+)\/?$/.exec(location.pathname);

/** The office key arrives in the link's #k= (or legacy ?k=); keep it in sessionStorage and scrub it from the address bar. */
function takeKey(office) {
  const hash = new URLSearchParams(location.hash.slice(1));
  const given = hash.get("k") || params.get("k");
  const slot = `office.key.${office}`;
  if (given) {
    try { sessionStorage.setItem(slot, given); } catch { /* storage blocked: the key lives only in this page */ }
    hash.delete("k");
    const search = new URLSearchParams(location.search);
    search.delete("k");
    const q = search.toString(), h = hash.toString();
    history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${h ? `#${h}` : ""}`);
    return given;
  }
  try { return sessionStorage.getItem(slot); } catch { return null; }
}

function initialTheme() {
  if (params.get("theme") === "night" || params.get("theme") === "day") return params.get("theme");
  try { const t = localStorage.getItem("office.theme"); if (t === "day" || t === "night") return t; } catch { /* default below */ }
  const h = new Date().getHours();
  return h >= 19 || h < 7 ? "night" : "day";
}

function boot() {
  const root = document.getElementById("app");
  if (!officeMatch && !demo) { root.hidden = true; document.getElementById("landing").hidden = false; return; }
  document.getElementById("landing").hidden = true;
  const office = demo ? "demo" : decodeURIComponent(officeMatch[1]);
  const key = demo ? null : takeKey(office);

  let state = null;
  let source = null;
  let selectedAgent = null;
  let role = null;

  const ui = createUi(root, {
    onSelectAgent: (id) => selectAgent(id),
    onSend: (msg) => { if (!source) throw new Error("not connected"); source.send(msg); },
    onTheme: () => setTheme(scene.theme === "day" ? "night" : "day"),
    onReset: () => scene.resetView(),
    onZoom: (f) => scene.zoom(f),
    onEdit: () => { const on = editor.toggle(); ui.setEditing(on); if (on) selectAgent(null); },
    onKick: (id) => { if (!source) throw new Error("not connected"); source.send({ type: "kick", id, as: asName() }); },
  });

  if (!demo && !key) {
    ui.screen(`<div class="card"><div class="big">🔑</div><h1>This office needs a key</h1>
      <p>Open the view link you were given — it looks like <code>${esc(location.origin)}/o/${esc(office)}#k=…</code>.</p>
      <p>No office yet? <a href="/">How agent office works</a> · <a href="/o/demo?demo=1">peek at the demo</a></p></div>`);
    return;
  }

  let scene;
  try {
    scene = createScene(root.querySelector(".stage"));
  } catch (e) {
    ui.screen(`<div class="card"><div class="big">🧊</div><h1>The office needs WebGL</h1><p>${esc(e.message)}</p></div>`);
    return;
  }
  const overlay = createOverlay(root.querySelector(".labels"), { onClick: (id) => selectAgent(id) });
  const editor = createEditor(root, { scene, send: (m) => source.send({ ...m, as: asName() }), getState: () => state, toast: ui.toast });
  scene.onFrame(() => overlay.update(scene.anchors()));
  const sideEl = root.querySelector(".side");
  const fitInsets = () => {
    const wide = window.innerWidth > 760;
    const dm = root.querySelector(".dm");
    scene.setInsets(wide ? sideEl.getBoundingClientRect().right : 0, wide && dm && !dm.hidden ? window.innerWidth - dm.getBoundingClientRect().left : 0);
  };
  window.addEventListener("resize", fitInsets);
  fitInsets();

  function asName() {
    const v = root.querySelector(".as-input").value.trim();
    if (!v) throw new Error("Pick a name to edit as first (bottom of the sidebar).");
    return v;
  }

  function setTheme(t) {
    scene.setTheme(t);
    ui.setTheme(t);
    try { localStorage.setItem("office.theme", t); } catch { /* fine */ }
  }
  setTheme(initialTheme());

  function selectAgent(id) {
    selectedAgent = id;
    overlay.setSelected(id);
    ui.setDm(id);
    fitInsets();
    if (id) scene.focusAgent(id);
  }

  function onFrame(frame) {
    if (frame.type === "error") { ui.toast(frame.error, "err"); return; }
    if (frame.type === "snapshot") {
      role = frame.role ?? null;
      const write = role === "owner";
      ui.setWrite(write);
      if (!write && role === null) console.warn("office: snapshot carries no role; treating this view as read-only");
    }
    try {
      state = applyFrame(state, frame);
    } catch (e) {
      ui.toast(`bad frame from the office: ${e.message}`, "err");
      console.error(e, frame);
      return;
    }
    document.title = `${state.name ?? state.id} · agent office`;
    const unknown = state.items.filter((it) => !kindOf(it.kind));
    if (unknown.length) console.warn("office: skipping items of unknown kind", unknown.map((it) => `${it.id}:${it.kind}`));
    try {
      scene.setState(unknown.length ? { ...state, items: state.items.filter((it) => kindOf(it.kind)) } : state);
    } catch (e) {
      console.error("office: scene update failed", e);
      ui.toast(`couldn't draw part of the office: ${e.message}`, "err");
    }
    overlay.setAgents(state.agents);
    ui.setState(state);
    editor.sync(state);
    ui.screen(null);
  }

  function onStatus({ state: st, detail }) {
    ui.setConn(st, detail);
    if (st === "not-found") {
      ui.screen(`<div class="card"><div class="big">404</div><h1>No office here</h1><p>There's no office called <code>${esc(office)}</code>. Check the link, or ask whoever set it up for a fresh one.</p><p><a href="/">agent office</a> · <a href="/o/demo?demo=1">see the demo</a></p></div>`);
      source?.close();
    } else if (st === "unauthorized") {
      ui.screen(`<div class="card"><div class="big">🔒</div><h1>That key doesn't open this office</h1><p>${esc(detail)}</p><p>Use the view link (read-only) or the owner link you were given.</p></div>`);
      source?.close();
    }
  }

  // clicks vs. orbit drags: only a press that barely moved is a click
  const canvas = scene.canvas;
  let down = null;
  canvas.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
  canvas.addEventListener("pointermove", (e) => {
    editor.move(e.clientX, e.clientY);
    if (!editor.on) {
      const hit = scene.pickAt(e.clientX, e.clientY, { items: false });
      canvas.style.cursor = hit?.type === "agent" ? "pointer" : "";
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 5 || e.button !== 0) return;
    if (editor.click(e.clientX, e.clientY)) return;
    const hit = scene.pickAt(e.clientX, e.clientY, { items: false });
    selectAgent(hit?.type === "agent" ? hit.id : null);
  });
  window.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea")) return;
    if (e.key === "Escape" && !editor.on) selectAgent(null);
  });

  source = demo ? connectDemo({ onFrame, onStatus, crowd: Number(params.get("crowd")) || 0 }) : connectLive({ office, key, onFrame, onStatus });
  if (params.get("fps") === "1") {
    const el = document.createElement("div");
    el.className = "fps";
    root.appendChild(el);
    let n = 0, t = performance.now();
    scene.onFrame((now) => { n++; if (now - t > 1000) { el.textContent = `${Math.round((n * 1000) / (now - t))} fps`; n = 0; t = now; } });
  }
  window.__office = { get state() { return state; }, scene, selectAgent, setTheme, editor, ui, get role() { return role; } };
}

boot();
