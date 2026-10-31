// The glass chrome around the office: sidebar (agents / room chat), the per-agent chat panel, the
// view controls, toasts and the full-screen states (no key, unknown office, offline).

import { chatWith, clip, hueColors, isHuman, lastLineOf, relTime, roomChat, speakerName, statusLabel } from "./model.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const TEXT_MAX = 280;

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** The first image file in a DataTransfer (drop or paste), or null. */
export function imageFrom(dt) {
  for (const f of dt?.files ?? []) if (IMAGE_TYPES.includes(f.type)) return f;
  for (const it of dt?.items ?? []) if (it.kind === "file" && IMAGE_TYPES.includes(it.type)) return it.getAsFile();
  return null;
}

export function createUi(root, { onSelectAgent, onSend, onTheme, onReset, onZoom, onEdit, onKick, onDesigner, onImage, onSide }) {
  root.insertAdjacentHTML("beforeend", `
    <aside class="side glass">
      <header class="side-head">
        <a class="brand" href="/" title="agent office"><span class="logo"></span>agent office</a>
        <button class="side-hide" title="hide the panel" aria-label="hide the panel">‹</button>
        <div class="oname"></div>
        <div class="conn"><i></i><span>connecting…</span></div>
      </header>
      <nav class="tabs">
        <button data-tab="agents" class="on">Agents <span class="count"></span></button>
        <button data-tab="room">Room chat <span class="unread" hidden></span></button>
      </nav>
      <div class="pane" data-pane="agents"><div class="agents"></div></div>
      <div class="pane" data-pane="room" hidden>
        <div class="log room-log"></div>
        <form class="composer" data-to="">
          <textarea rows="1" maxlength="${TEXT_MAX}" placeholder="Say something to the room…"></textarea>
          <button type="submit" title="send">➤</button>
        </form>
      </div>
      <footer class="side-foot">
        <label class="as" hidden>chatting as <input class="as-input" maxlength="32" placeholder="your name" spellcheck="false"></label>
        <div class="ro" hidden>Read-only view. Open the owner link to chat and edit.</div>
      </footer>
    </aside>
    <button class="side-show glass" title="show the panel" aria-label="show the panel" hidden>☰ <span class="side-show-n"></span></button>
    <section class="dm glass" hidden>
      <header class="dm-head"></header>
      <div class="log dm-log"></div>
      <form class="composer" data-to="dm">
        <textarea rows="1" maxlength="${TEXT_MAX}" placeholder="Message…"></textarea>
        <button type="submit" title="send">➤</button>
      </form>
    </section>
    <div class="ctrls glass">
      <button data-act="theme" title="day / night"><span class="sun">☀︎</span><span class="moon">☾</span></button>
      <button data-act="reset" title="reset view">⌂</button>
      <button data-act="in" title="zoom in">+</button>
      <button data-act="out" title="zoom out">−</button>
      <button data-act="edit" title="edit the office" hidden>✎</button>
    </div>
    <div class="ctxmenu glass" hidden></div>
    <div class="toasts"></div>
    <div class="empty glass" hidden></div>
    <div class="screen" hidden></div>
  `);
  const $ = (s) => root.querySelector(s);
  const side = $(".side"), dm = $(".dm");
  let state = null, role = null, canWrite = false, dmAgent = null, tab = "agents", roomSeen = 0;

  const asInput = $(".as-input");
  try { asInput.value = localStorage.getItem("office.as") ?? ""; } catch { /* storage blocked: ask each time */ }
  asInput.addEventListener("change", () => { try { localStorage.setItem("office.as", asInput.value.trim()); } catch { /* fine */ } });

  function setSide(open) {
    root.classList.toggle("side-off", !open);
    side.hidden = !open;
    $(".side-show").hidden = open;
    try { localStorage.setItem("office.side", open ? "on" : "off"); } catch { /* fine: not remembered */ }
    onSide();
  }
  $(".side-hide").addEventListener("click", () => setSide(false));
  $(".side-show").addEventListener("click", () => setSide(true));
  let sideStored = null;
  try { sideStored = localStorage.getItem("office.side"); } catch { /* default: open */ }
  if (sideStored === "off") { root.classList.add("side-off"); side.hidden = true; $(".side-show").hidden = false; }

  root.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  function setTab(t) {
    tab = t;
    root.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    root.querySelectorAll(".pane").forEach((p) => { p.hidden = p.dataset.pane !== t; });
    if (t === "room") { roomSeen = state ? roomChat(state.chat).length : 0; renderRoom(); }
    updateUnread();
  }

  $(".ctrls").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "theme") onTheme();
    else if (act === "reset") onReset();
    else if (act === "in") onZoom(0.75);
    else if (act === "out") onZoom(1.33);
    else if (act === "edit") onEdit();
  });

  for (const form of root.querySelectorAll(".composer")) {
    const ta = form.querySelector("textarea");
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    ta.addEventListener("input", () => { ta.style.height = "auto"; ta.style.height = `${Math.min(120, ta.scrollHeight)}px`; });
    const takeImage = (file) => {
      if (!canWrite) { toast("Only the owner link can upload images.", "err"); return; }
      const to = form.dataset.to === "dm" ? dmAgent : null;
      onImage(file, to);
    };
    ta.addEventListener("paste", (e) => {
      const f = imageFrom(e.clipboardData);
      if (f) { e.preventDefault(); takeImage(f); }
    });
    form.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types ?? [])].includes("Files")) { e.preventDefault(); form.classList.add("drop"); } });
    form.addEventListener("dragleave", () => form.classList.remove("drop"));
    form.addEventListener("drop", (e) => {
      form.classList.remove("drop");
      const f = imageFrom(e.dataTransfer);
      if (!f) return;
      e.preventDefault();
      takeImage(f);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      const as = asInput.value.trim();
      if (!as) { asInput.focus(); toast("Pick a name to chat as first (bottom of the sidebar)."); return; }
      const to = form.dataset.to === "dm" ? dmAgent : null;
      try {
        onSend({ type: "chat", to, text, as });
        ta.value = "";
        ta.style.height = "auto";
      } catch (err) {
        toast(err.message, "err");
      }
    });
  }

  function agentRow(a) {
    const last = lastLineOf(state.chat, a.id);
    const col = hueColors(a.hue ?? 0);
    const line = a.status === "working" && a.activity ? a.activity : last ? `“${last.text}”` : a.client ?? "";
    const designer = state.designer === a.id;
    return `<button class="agent ${a.status} ${dmAgent === a.id ? "sel" : ""} ${designer ? "designer" : ""}" data-id="${esc(a.id)}">
      <span class="av" style="--hue:${col.css}">${a.emoji ? esc(a.emoji) : esc(a.name.slice(0, 1).toUpperCase())}</span>
      <span class="who"><b>${esc(a.name)}${designer ? ` <em class="badge" title="this office's designer">Designer</em>` : ""}</b><small>${esc(clip(line, 64))}</small></span>
      <span class="st"><i class="dot ${a.status}"></i>${esc(statusLabel(a.status))}</span>
    </button>`;
  }

  const ORDER = { waiting: 0, working: 1, idle: 2, away: 3 };
  function renderAgents() {
    const list = [...state.agents].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name));
    $(".agents").innerHTML = list.length ? list.map(agentRow).join("") : `<div class="none">Nobody's in yet.</div>`;
    $(".count").textContent = String(list.length);
    $(".side-show-n").textContent = list.length ? String(list.length) : "";
  }
  $(".agents").addEventListener("click", (e) => {
    const b = e.target.closest(".agent");
    if (b) onSelectAgent(b.dataset.id);
  });
  $(".agents").addEventListener("contextmenu", (e) => {
    const b = e.target.closest(".agent");
    if (!b || !canWrite) return;
    e.preventDefault();
    agentMenu(b.dataset.id, e.clientX, e.clientY);
  });

  // owner context menu on an agent (sidebar row or name pill): DM, make / unmake designer, show out
  const menu = $(".ctxmenu");
  function agentMenu(id, x, y) {
    const a = state?.agents.find((g) => g.id === id);
    if (!a || !canWrite) return;
    const isDesigner = state.designer === id;
    menu.innerHTML = `
      <div class="cm-head">${esc(a.name)}</div>
      <button data-cm="dm">Message ${esc(a.name)}</button>
      <button data-cm="designer">${isDesigner ? "Stop being the designer" : "Make designer"}</button>
      <button data-cm="kick" class="danger">Show out…</button>`;
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
    menu.onclick = (e) => {
      const act = e.target.closest("[data-cm]")?.dataset.cm;
      if (!act) return;
      menu.hidden = true;
      try {
        if (act === "dm") onSelectAgent(id);
        else if (act === "designer") onDesigner(isDesigner ? null : id);
        else if (act === "kick" && confirm(`Show ${a.name} out of the office? They can rejoin with the join key.`)) { onKick(id); onSelectAgent(null); }
      } catch (err) { toast(err.message, "err"); }
    };
  }
  window.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.hidden = true; });

  /** A chat line that mentions one of this office's uploaded images shows it inline. */
  function assetPreview(text) {
    const m = /\b(a[0-9a-f]{23})\b/.exec(text);
    const asset = m && state.assets?.find((x) => x.id === m[1]);
    return asset ? `<img class="att" alt="" src="${esc(asset.url)}" width="${asset.w}" height="${asset.h}">` : "";
  }

  function msgHtml(m, { showTo }) {
    const human = isHuman(m.from);
    const a = human ? null : state.agents.find((x) => x.id === m.from);
    const col = a ? hueColors(a.hue ?? 0).css : "var(--ink-2)";
    const toName = m.to ? speakerName(m.to, state.agents) : null;
    return `<div class="msg ${human ? "human" : ""}">
      <div class="meta"><b style="color:${col}">${esc(speakerName(m.from, state.agents))}</b>${showTo && toName ? ` <span class="to">→ ${esc(toName)}</span>` : ""}<time>${relTime(m.ts)}</time></div>
      <div class="text">${esc(m.text)}</div>${assetPreview(m.text)}
    </div>`;
  }

  function fillLog(el, msgs, opts, emptyText) {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = msgs.length ? msgs.map((m) => msgHtml(m, opts)).join("") : `<div class="none">${emptyText}</div>`;
    if (atBottom || el.dataset.fresh !== "1") { el.scrollTop = el.scrollHeight; el.dataset.fresh = "1"; }
  }

  function renderRoom() {
    if (tab !== "room") return;
    fillLog($(".room-log"), roomChat(state.chat), { showTo: false }, "No room chat yet.");
  }

  function updateUnread() {
    const n = state ? roomChat(state.chat).length - roomSeen : 0;
    const u = $(".unread");
    if (tab === "room") roomSeen = state ? roomChat(state.chat).length : 0;
    u.hidden = tab === "room" || n <= 0;
    u.textContent = String(Math.min(99, n));
  }

  function renderDm() {
    if (!dmAgent || role === "view") { dm.hidden = true; return; }
    const a = state.agents.find((x) => x.id === dmAgent);
    if (!a) { dm.querySelector(".dm-head").innerHTML = `<div class="who"><b>${esc(dmAgent)}</b><small>left the office</small></div><button class="x" title="close">×</button>`; }
    else {
      const col = hueColors(a.hue ?? 0);
      dm.querySelector(".dm-head").innerHTML = `
        <span class="av" style="--hue:${col.css}">${a.emoji ? esc(a.emoji) : esc(a.name.slice(0, 1).toUpperCase())}</span>
        <div class="who"><b>${esc(a.name)}${state.designer === a.id ? ` <em class="badge">Designer</em>` : ""}</b><small><i class="dot ${a.status}"></i>${esc(statusLabel(a.status))}${a.client ? ` · ${esc(a.client)}` : ""}${a.activity ? ` · ${esc(clip(a.activity, 60))}` : ""}</small></div>
        <button class="x" title="close">×</button>
        ${canWrite ? `<div class="dm-acts"><button class="mkdes ${state.designer === a.id ? "on" : ""}" title="${state.designer === a.id ? "stop treating this agent as the office designer" : "make this agent the office designer: it restyles the office from your chat"}">${state.designer === a.id ? "★ designer" : "☆ make designer"}</button><button class="kick" title="show ${esc(a.name)} out of the office">show out</button></div>` : ""}`;
      const mk = dm.querySelector(".mkdes");
      if (mk) mk.onclick = () => { try { onDesigner(state.designer === a.id ? null : a.id); } catch (err) { toast(err.message, "err"); } };
      const kick = dm.querySelector(".kick");
      if (kick) kick.onclick = () => {
        if (!confirm(`Show ${a.name} out of the office? They can rejoin with the join key.`)) return;
        try { onKick(a.id); onSelectAgent(null); } catch (err) { toast(err.message, "err"); }
      };
    }
    dm.querySelector(".x").onclick = () => onSelectAgent(null);
    fillLog(dm.querySelector(".dm-log"), chatWith(state.chat, dmAgent), { showTo: true }, `No messages with ${esc(a?.name ?? dmAgent)} yet.`);
    dm.hidden = false;
    const ta = dm.querySelector("textarea");
    ta.placeholder = a ? (state.designer === a.id ? `Ask ${a.name} for a redesign · drop a logo` : `Message ${a.name}…`) : "This agent left";
    dm.querySelector(".composer").hidden = !canWrite || !a;
  }

  function render() {
    if (!state) return;
    $(".oname").textContent = state.name ?? state.id;
    renderAgents();
    renderRoom();
    renderDm();
    updateUnread();
    const empty = $(".empty");
    empty.hidden = state.agents.length > 0;
    if (!empty.hidden) empty.innerHTML = `<b>The office is open — nobody's in yet.</b>${role === "view"
      ? `<span>This is a watch-only link. The owner can share a join key to bring agents in.</span>`
      : `<span>Connect any agent over MCP or the CLI, and it will walk in and take a desk.</span>${role === "owner" || role === "join" ? `<button class="cx-open cx-empty" data-connect><span class="cx-plus">+</span>Connect an agent</button>` : ""}`}`;
  }

  // refresh relative times now and then
  setInterval(() => { if (state) { renderRoom(); if (dmAgent) renderDm(); } }, 30000);

  function toast(text, kind = "") {
    const t = document.createElement("div");
    t.className = `toast ${kind}`;
    t.textContent = text;
    $(".toasts").appendChild(t);
    setTimeout(() => t.classList.add("out"), 3800);
    setTimeout(() => t.remove(), 4300);
  }

  return {
    setState(s) { state = s; render(); },
    setWrite(w) {
      canWrite = w;
      root.querySelector(".side .composer").hidden = !w;
      $(".as").hidden = !w;
      $(".ro").hidden = w;
      $('[data-act="edit"]').hidden = !w;
      if (state) renderDm();
    },
    setRole(r) {
      role = r;
      const watchOnly = r === "view";
      $(".side .tabs").hidden = watchOnly;
      if (watchOnly && tab === "room") setTab("agents");
      $(".ro").textContent = r === "view"
        ? "Watch-only link: you can see the office but not chat, edit or bring agents in. The owner can share a join key."
        : r === "join" ? "Join link: you can connect agents. Open the owner link to chat and edit."
        : "Read-only view. Open the owner link to chat and edit.";
      if (state) render();
    },
    setDm(id) { dmAgent = id; if (state) { renderDm(); renderAgents(); } },
    setConn(st, detail) {
      const c = $(".conn");
      c.dataset.state = st;
      c.querySelector("span").textContent = st === "live" ? (detail === "demo" ? "demo · simulated" : "live") : detail || st;
    },
    setTheme(theme) { root.dataset.theme = theme; },
    setEditing(on) { $('[data-act="edit"]').classList.toggle("on", on); root.classList.toggle("editing", on); },
    screen(html) {
      const s = $(".screen");
      s.hidden = !html;
      s.innerHTML = html ?? "";
    },
    toast,
    agentMenu,
    get sidebar() { return side; },
  };
}
