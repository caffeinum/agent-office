// Entry: route (/ = landing, /o/:office = the office), connect the data source, and wire the scene,
// overlay, sidebar and editor together. State only ever changes through applyFrame().

import { applyFrame } from "./model.js";
import { kindOf } from "../shared/catalog.js";
import { createScene } from "./scene.js";
import { createOverlay } from "./overlay.js";
import { createUi, imageFrom } from "./ui.js";
import { createEditor } from "./editor.js";
import { createConnect } from "./connect.js";
import { connectDemo, connectLive } from "./source.js";
import { errorBanner } from "./city/banner.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const params = new URLSearchParams(location.search);
const demo = params.get("demo") === "1";
const officeMatch = /^\/o\/([^/]+)\/?$/.exec(location.pathname);

const keySlot = (office) => `office.key.${office}`;

/** The office key arrives in the link's #k= (or legacy ?k=). Remember it in this browser (a newer #k= replaces it) and scrub it from the address bar. */
function takeKey(office) {
  const hash = new URLSearchParams(location.hash.slice(1));
  const given = hash.get("k") || params.get("k");
  const slot = keySlot(office);
  if (given) {
    try { localStorage.setItem(slot, given); } catch { /* storage blocked: try the tab's storage */ }
    try { sessionStorage.setItem(slot, given); } catch { /* storage blocked: the key lives only in this page */ }
    hash.delete("k");
    const search = new URLSearchParams(location.search);
    search.delete("k");
    const q = search.toString(), h = hash.toString();
    history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${h ? `#${h}` : ""}`);
    return given;
  }
  try { const k = localStorage.getItem(slot); if (k) return k; } catch { /* fall back to the tab */ }
  try { return sessionStorage.getItem(slot); } catch { return null; }
}

/** The server refused the remembered key: forget it so the next visit asks for a fresh link. */
function forgetKey(office) {
  try { localStorage.removeItem(keySlot(office)); } catch { /* nothing stored */ }
  try { sessionStorage.removeItem(keySlot(office)); } catch { /* nothing stored */ }
}

function initialTheme() {
  if (params.get("theme") === "night" || params.get("theme") === "day") return params.get("theme");
  try { const t = localStorage.getItem("office.theme"); if (t === "day" || t === "night") return t; } catch { /* default below */ }
  const h = new Date().getHours();
  return h >= 19 || h < 7 ? "night" : "day";
}

function boot() {
  const cityMatch = /^\/city\/([a-z0-9-]+)\/?$/.exec(location.pathname);
  if (cityMatch) {
    document.getElementById("app").hidden = true;
    document.getElementById("landing").hidden = true;
    import("./city/app.js").then((m) => m.bootCity(cityMatch[1]), (e) => {
      errorBanner(`could not load the city viewer (${e.message})`);
      console.error(e);
    });
    return;
  }
  const root = document.getElementById("app");
  if (!officeMatch && !demo) { root.hidden = true; document.getElementById("landing").hidden = false; return; }
  document.getElementById("landing").hidden = true;
  const office = demo ? "demo" : decodeURIComponent(officeMatch[1]);
  const key = demo ? null : takeKey(office);

  let state = null;
  let source = null;
  let selectedAgent = null;
  let role = null;
  let fitInsets = null;

  const ui = createUi(root, {
    onSelectAgent: (id) => selectAgent(id),
    onSend: (msg) => { if (!source) throw new Error("not connected"); source.send(msg); },
    onTheme: () => setTheme(scene.theme === "day" ? "night" : "day"),
    onReset: () => scene.resetView(),
    onZoom: (f) => scene.zoom(f),
    onEdit: () => { const on = editor.toggle(); ui.setEditing(on); if (on) selectAgent(null); },
    onKick: (id) => { if (!source) throw new Error("not connected"); source.send({ type: "kick", id, as: asName() }); },
    onDesigner: (id) => {
      if (!source) throw new Error("not connected");
      source.send({ type: "designer", id, as: asName() });
    },
    onImage: (file, to) => { shareImage(file, to).catch((e) => ui.toast(e.message, "err")); },
    onSide: () => fitInsets?.(),
  });

  /** Owner dropped/pasted an image into a chat box: upload it, then tell the agent (DM, else the designer, else the room) its asset id. */
  async function shareImage(file, to) {
    const as = asName();
    if (file.size > 512 * 1024) throw new Error(`${file.name || "that image"} is ${Math.round(file.size / 1024)} KB; the office takes images up to 512 KB`);
    ui.toast(`Uploading ${file.name || "image"}…`);
    const res = await source.upload(file);
    const target = to ?? state?.designer ?? null;
    const text = `🖼 here's an image: asset ${res.assetId} (${res.w}×${res.h}) ${res.url} — office_set_logo {"assetId":"${res.assetId}"} puts it on the screens`;
    source.send({ type: "chat", to: target, text, as });
    ui.toast(target ? `Sent the image to ${state.agents.find((a) => a.id === target)?.name ?? target}` : "Shared the image with the room");
  }

  /** Edit panel: upload an image and make it the office logo straight away. */
  async function uploadLogo(file) {
    if (file.size > 512 * 1024) throw new Error(`${file.name || "that image"} is ${Math.round(file.size / 1024)} KB; the office takes images up to 512 KB`);
    ui.toast(`Uploading ${file.name || "logo"}…`);
    const res = await source.upload(file);
    await source.setLogo(res.assetId);
    ui.toast("Logo set — it's on the TV and every screen now");
  }

  if (!demo && !key) {
    ui.screen(`<div class="card"><div class="big">🔑</div><h1>This office needs a key</h1>
      <p>Open the view link you were given — it looks like <code>${esc(location.origin)}/o/${esc(office)}#k=…</code>.</p>
      <p>No office yet? <a href="/">How agent office works</a> · <a href="/o/demo?demo=1">peek at the demo</a></p></div>`);
    return;
  }

  let scene;
  try {
    scene = createScene(root.querySelector(".stage"), { onError: (msg) => ui.toast(msg, "err") });
  } catch (e) {
    ui.screen(`<div class="card"><div class="big">🧊</div><h1>The office needs WebGL</h1><p>${esc(e.message)}</p></div>`);
    return;
  }
  const overlay = createOverlay(root.querySelector(".labels"), { onClick: (id) => selectAgent(id), onMenu: (id, x, y) => ui.agentMenu(id, x, y) });
  const editor = createEditor(root, {
    scene, send: (m) => source.send({ ...m, as: asName() }), getState: () => state, toast: ui.toast,
    uploadLogo: (file) => uploadLogo(file).catch((e) => ui.toast(e.message, "err")),
    setLogo: (id) => source.setLogo(id).then(() => ui.toast(id ? "Logo set" : "Logo removed")).catch((e) => ui.toast(e.message, "err")),
  });
  const connect = key ? createConnect(root, { office, key, toast: ui.toast, onDeleted: () => { forgetKey(office); location.assign("/"); } }) : null;
  scene.onFrame(() => overlay.update(scene.anchors()));
  const sideEl = root.querySelector(".side");
  fitInsets = () => {
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
    else scene.unfollow();
  }

  function onFrame(frame) {
    if (frame.type === "error") { ui.toast(frame.error, "err"); return; }
    if (frame.type === "snapshot") {
      role = frame.role ?? null;
      const write = role === "owner";
      ui.setWrite(write, role === "join" ? (frame.as ?? null) : null);
      ui.setRole(connect ? role : null);
      connect?.setRole(role);
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
    const unknown = state.items.filter((it) => !kindOf(it.kind, state.customKinds));
    if (unknown.length) console.warn("office: skipping items of unknown kind", unknown.map((it) => `${it.id}:${it.kind}`));
    try {
      scene.setState(unknown.length ? { ...state, items: state.items.filter((it) => kindOf(it.kind, state.customKinds)) } : state);
    } catch (e) {
      console.error("office: scene update failed", e);
      ui.toast(`couldn't draw part of the office: ${e.message}`, "err");
    }
    overlay.setAgents(state.agents);
    overlay.setDesigner(state.designer);
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
      forgetKey(office);
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
  // an image dropped on the office goes to the agent you're talking to (or the designer)
  canvas.addEventListener("dragover", (e) => { if (role === "owner" && [...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault(); });
  canvas.addEventListener("drop", (e) => {
    const f = imageFrom(e.dataTransfer);
    if (!f || role !== "owner") return;
    e.preventDefault();
    shareImage(f, selectedAgent).catch((err) => ui.toast(err.message, "err"));
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
