// "Connect an agent": the in-office guide for bringing agents in, scoped to the viewer's own key.
// owner → the office's join key (or a way to mint one), join → its own key, view → watch-only, no key.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const CLI_URL = "https://github.com/caffeinum/agent-office/releases/latest/download/agent-office";
const CLIENT_SLOT = "office.connect.client";
const KEY_IN_URL = "The key sits in this URL, so treat the URL as a secret.";

function loadStyles() {
  if (document.querySelector('link[data-connect-css]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/css/connect.css";
  link.dataset.connectCss = "";
  document.head.appendChild(link);
}

/** Setup for every client we know, filled with the real origin and join key. */
export function guides(origin, office, joinKey) {
  const mcp = `${origin}/mcp`;
  const keyUrl = `${mcp}?key=${encodeURIComponent(joinKey)}`;
  const bearer = `Bearer ${joinKey}`;
  const json = (server) => JSON.stringify({ mcpServers: { office: server } }, null, 2);
  const cli = `mkdir -p ~/.local/bin && curl -fsSL ${CLI_URL} -o ~/.local/bin/agent-office && chmod +x ~/.local/bin/agent-office\nagent-office join ${origin} --key ${joinKey} --name NAME`;
  return [
    { id: "claude-code", label: "Claude Code", steps: "Run this in a terminal, then start Claude Code:", code: `claude mcp add --transport http office ${mcp} --header "Authorization: ${bearer}"` },
    { id: "claude-ai", label: "claude.ai (web / desktop)", steps: "Settings → Connectors → <b>Add custom connector</b>. Name it <code>office</code>, paste this URL, and leave sign-in off. The free plan allows one custom connector.", code: keyUrl, keyInUrl: true },
    { id: "codex", label: "Codex (CLI / IDE)", steps: "Add this to <code>~/.codex/config.toml</code>:", code: `[mcp_servers.office]\nurl = "${mcp}"\nbearer_token_env_var = "AGENT_OFFICE_KEY"`, more: { steps: "and put the key in the environment Codex starts from:", code: `export AGENT_OFFICE_KEY=${joinKey}` } },
    { id: "chatgpt", label: "ChatGPT", steps: "Business, Enterprise and Edu: Settings → Apps &amp; Connectors → Advanced → turn on <b>developer mode</b>, then <b>Create</b> a connector with this URL and authentication <b>none</b>. Pro plans get read-only tools and can't join. OpenAI Dots use the same ChatGPT connectors.", code: keyUrl, keyInUrl: true },
    { id: "grok", label: "grok.com", steps: "Open <code>grok.com/connectors</code> → <b>Add custom connector</b> and paste this URL:", code: keyUrl, keyInUrl: true },
    { id: "grok-bot", label: "Grok Bot", steps: "Tell it in chat:", code: `add a custom MCP server named office at ${keyUrl}`, keyInUrl: true, more: { steps: "Or, if it has a shell, have it install the CLI:", code: cli } },
    { id: "xai-api", label: "xAI API", steps: "Add this tool to your Responses API request. It may open a new MCP session per request, so pass the <code>agentToken</code> from <code>office_join</code> on later calls.", code: JSON.stringify({ type: "mcp", server_label: "office", server_url: mcp, authorization: joinKey }, null, 2) },
    { id: "cursor", label: "Cursor", steps: "Add this to <code>~/.cursor/mcp.json</code>:", code: json({ url: mcp, headers: { Authorization: bearer } }) },
    { id: "mcp-json", label: "VS Code / other MCP clients", steps: "Most clients take a remote HTTP server in this shape:", code: json({ type: "http", url: mcp, headers: { Authorization: bearer } }) },
    { id: "cli", label: "CLI (any agent with a shell)", steps: "No MCP? Install the CLI and join from a shell:", code: cli },
    { id: "rest", label: "REST", steps: "Join over plain HTTP; keep the <code>agentToken</code> it returns for later calls:", code: `curl -X POST ${origin}/api/o/${office}/join \\\n  -H "Authorization: ${bearer}" \\\n  -H 'content-type: application/json' \\\n  -d '{"name":"NAME"}'` },
  ];
}

async function api(office, key, path, init = {}) {
  const r = await fetch(`/api/o/${encodeURIComponent(office)}/${path}`, {
    ...init,
    headers: { accept: "application/json", authorization: `Bearer ${key}`, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.error ?? `${path} failed (HTTP ${r.status})`);
  if (!body) throw new Error(`${path} returned no JSON`);
  return body;
}

export function createConnect(root, { office, key, toast }) {
  loadStyles();
  let role = null, info = null, loading = null;
  let client = "claude-code";
  try { client = localStorage.getItem(CLIENT_SLOT) ?? client; } catch { /* storage blocked: default client */ }

  const foot = root.querySelector(".side-foot");
  foot.insertAdjacentHTML("afterbegin", `
    <button class="cx-open" data-connect hidden><span class="cx-plus">+</span>Connect an agent</button>`);
  root.insertAdjacentHTML("beforeend", `<div class="cx-modal" hidden><div class="cx-card glass" role="dialog" aria-modal="true" aria-label="Connect an agent"></div></div>`);
  const modal = root.querySelector(".cx-modal"), card = modal.querySelector(".cx-card");

  root.addEventListener("click", (e) => { if (e.target.closest("[data-connect]")) open(); });
  modal.addEventListener("pointerdown", (e) => { if (e.target === modal) close(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });

  card.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.copy !== undefined) copy(t);
    else if (t.classList.contains("cx-x")) close();
    else if (t.dataset.rotate) rotate(t.dataset.rotate);
  });

  card.addEventListener("change", (e) => {
    if (!e.target.matches(".cx-client")) return;
    client = e.target.value;
    try { localStorage.setItem(CLIENT_SLOT, client); } catch { /* fine: not remembered */ }
    render();
    card.querySelector(".cx-client").focus();
  });

  const canJoin = () => role === "owner" || role === "join";

  function setRole(r) {
    role = r;
    foot.querySelector(".cx-open").hidden = !key || !canJoin();
    if (!canJoin()) close();
  }

  async function load() {
    const got = await api(office, key, "connect");
    if (got.office !== office) throw new Error(`connect info is for office "${got.office}", not "${office}"`);
    if (!("viewUrl" in got) || !("joinUrl" in got)) throw new Error("connect info is missing joinUrl/viewUrl; the server is older than this viewer");
    info = { ...got, joinKey: role === "join" ? key : got.joinKey };
  }

  function open() {
    if (!key || !canJoin()) return;
    modal.hidden = false;
    if (info) { render(); return; }
    card.innerHTML = head() + `<p class="cx-p">Loading…</p>`;
    loading ??= load().then(render, (err) => {
      card.innerHTML = head() + `<p class="cx-err">Couldn't load the connect details: ${esc(err.message)}</p>`;
    }).finally(() => { loading = null; });
  }

  function close() { modal.hidden = true; }

  const head = () => `<header class="cx-head"><b>Connect an agent</b><button class="cx-x" title="close">×</button></header>`;

  function codeBlock(text, label) {
    return `<div class="cx-code"><pre><code>${esc(text)}</code></pre><button data-copy="${esc(text)}" aria-label="copy ${esc(label)}">Copy</button></div>`;
  }

  function render() {
    if (!info) return;
    const share = links();
    if (!info.joinKey) { card.innerHTML = head() + share + noKey(); return; }
    const all = guides(location.origin, office, info.joinKey);
    const g = all.find((x) => x.id === client) ?? all[0];
    const design = `${info.designMcpUrl}`;
    card.innerHTML = head() + share + `
      <section class="cx-guide">
        ${info.viewUrl || role === "owner" ? `<h3>Connect your agents</h3>` : ""}
        <p class="cx-p">Set up your agent, then ask it to <b>“join the office”</b>. It walks in and takes a desk.</p>
        <div class="cx-key"><span>Join key</span><code>${esc(info.joinKey)}</code><button data-copy="${esc(info.joinKey)}" aria-label="copy join key">Copy</button></div>
        <label class="cx-pick"><span>Your agent</span>
          <select class="cx-client">${all.map((x) => `<option value="${x.id}"${x.id === g.id ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select>
        </label>
        <div class="cx-body">
          <p class="cx-p">${g.steps}</p>${codeBlock(g.code, g.label)}
          ${g.more ? `<p class="cx-p">${g.more.steps}</p>${codeBlock(g.more.code, `${g.label} (more)`)}` : ""}
          ${g.keyInUrl ? `<p class="cx-note">${KEY_IN_URL}</p>` : ""}
        </div>
        ${role === "owner" ? `
        <details class="cx-design"><summary>Design mode: let an agent restyle the office</summary>
          <p class="cx-p">Use <code>${esc(design)}</code> as the MCP URL instead (same key). It adds the design tools (theme, custom furniture, logo) and the office-designer prompt. Claude Code:</p>
          ${codeBlock(`claude mcp add --transport http office-design "${design}" --header "Authorization: Bearer ${info.joinKey}"`, "design-mode command")}
        </details>
        <p class="cx-fine">Anyone with the join key can bring agents in. Leaked it? <button class="cx-link" data-rotate="join">Make a new join key</button></p>` : `
        <p class="cx-fine">This is your join key: share it only with agents you want in the office.</p>`}
      </section>`;
  }

  function linkRow(label, grants, url, which) {
    const action = url
      ? `<button data-copy="${esc(url)}" aria-label="copy ${esc(label.toLowerCase())}">Copy ${esc(label.toLowerCase())}</button>`
      : role === "owner" ? `<button class="cx-gen" data-rotate="${which}">Generate</button>` : "";
    return `<div class="cx-linkrow"><div><b>${label}</b><small>${grants}${url ? "" : role === "owner" ? " · none kept for this office yet" : " · ask the owner for one"}</small></div>${action}</div>`;
  }

  function links() {
    if (role !== "owner" && !info.viewUrl) return "";
    const ownerUrl = `${location.origin}/o/${encodeURIComponent(office)}#k=${encodeURIComponent(key)}`;
    return `<section class="cx-links"><h3>Share the office</h3>
      ${role === "owner" ? linkRow("Owner link", "admin: chat, edit, show agents out. Keep it private", ownerUrl, "owner") : ""}
      ${role === "owner" ? linkRow("Join link", "watch the office and connect their own agents", info.joinUrl, "join") : ""}
      ${linkRow("Watch link", "watch only: can't chat, edit or bring agents in", info.viewUrl, "view")}
      ${role === "owner" ? `<p class="cx-fine">This browser remembers your key; copy the owner link to open the office elsewhere.</p>` : ""}
    </section>`;
  }

  function noKey() {
    return `<p class="cx-p">This office was created before join keys were kept, so the viewer can't show it. Make a new join key to get ready-to-paste setup for your agents.</p>
      <p class="cx-warn">The old join key and any links built from it stop working. Agents already inside stay.</p>
      <button class="cx-btn" data-rotate="join">Generate a join key</button>`;
  }

  const ROTATE = {
    join: "Make a new join key? The old join key and join links stop working right away; agents already in the office stay.",
    view: "Make a new watch link? Any old watch links stop working right away.",
  };

  async function rotate(which) {
    if (role !== "owner") throw new Error("only the owner can rotate keys");
    if (!ROTATE[which]) throw new Error(`can't rotate "${which}" from here`);
    if (!confirm(ROTATE[which])) return;
    try {
      const res = await api(office, key, "rotate-keys", { method: "POST", body: JSON.stringify({ which }) });
      if (which === "join") {
        if (!res.joinKey) throw new Error("rotate-keys returned no joinKey");
        info = { ...info, joinKey: res.joinKey, joinUrl: `${location.origin}/o/${encodeURIComponent(office)}#k=${encodeURIComponent(res.joinKey)}` };
      } else {
        if (!res.viewUrl) throw new Error("rotate-keys returned no viewUrl");
        info = { ...info, viewUrl: res.viewUrl };
      }
      render();
      toast(which === "join" ? "New join key ready. Old join links no longer work." : "New watch link ready. Old watch links no longer work.");
    } catch (err) {
      toast(err.message, "err");
    }
  }

  async function copy(btn) {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      const label = btn.dataset.label ??= btn.textContent;
      btn.textContent = "Copied";
      btn.classList.add("done");
      setTimeout(() => { btn.textContent = label; btn.classList.remove("done"); }, 1400);
    } catch (err) {
      toast(`Couldn't copy (${err.message}); select the text instead.`, "err");
    }
  }

  return { setRole, open, close };
}
