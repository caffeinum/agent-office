// "Connect an agent": the in-office guide for bringing agents in, scoped to the viewer's own key.
// owner → the office's join key (or a way to mint one), join → its own key, view → watch-only, no key.
// Owners invite people by name: each gets their own join link, their agents show "via <name>", and revoking one
// link touches only that person. New links never revoke old ones; revoking is always its own explicit action.

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
    else if (t.dataset.invite !== undefined) invite();
    else if (t.dataset.revoke) revoke(t.dataset.revoke);
    else if (t.dataset.addView !== undefined) addView();
    else if (t.dataset.revokeViews !== undefined) revokeOtherViews();
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
        <p class="cx-fine">Anyone with a join key can bring agents in. Give each person their own link above, so you can revoke just theirs.</p>` : `
        <p class="cx-fine">This is your join key: share it only with agents you want in the office.</p>`}
      </section>`;
  }

  const linkOf = (k) => `${location.origin}/o/${encodeURIComponent(office)}#k=${encodeURIComponent(k)}`;
  const copyBtn = (url, what) => `<button data-copy="${esc(url)}" aria-label="copy ${esc(what)}">Copy</button>`;

  function linkRow(label, grants, action) {
    return `<div class="cx-linkrow"><div><b>${label}</b><small>${grants}</small></div>${action}</div>`;
  }

  function inviteRow(inv) {
    const who = inv.label === "everyone" ? "Everyone (shared join key)" : esc(inv.label);
    const n = inv.agents ? ` · ${inv.agents} agent${inv.agents === 1 ? "" : "s"} in` : "";
    const action = `${inv.url ? copyBtn(inv.url, `${inv.label}'s join link`) : ""}<button class="cx-gen cx-revoke" data-revoke="${esc(inv.id)}" aria-label="revoke ${esc(inv.label)}'s join link">Revoke</button>`;
    return linkRow(who, `${inv.url ? "join link" : "link not kept: revoke and invite again to share"}${n}`, action);
  }

  function links() {
    if (role !== "owner") {
      return info.viewUrl ? `<section class="cx-links"><h3>Share the office</h3>${linkRow("Public link", "watch only, no agents or chat", copyBtn(info.viewUrl, "public link"))}</section>` : "";
    }
    const invites = info.invites ?? [];
    const view = info.viewUrl
      ? copyBtn(info.viewUrl, "public link")
      : `<button class="cx-gen" data-add-view title="adds a public link; nothing is revoked">Generate</button>`;
    const revokeViews = info.viewUrl && info.viewKeys > 1
      ? `<p class="cx-fine">${info.viewKeys} public links work right now. <button class="cx-link" data-revoke-views>Revoke all but the one above</button></p>` : "";
    return `<section class="cx-links"><h3>Share the office</h3>
      ${linkRow("Admin link (bookmark this)", "you: chat, edit, show agents out, delete. Keep it private", copyBtn(linkOf(key), "admin link"))}
      <h3 class="cx-sub">Join links <small>for friends: watch + connect their agents</small></h3>
      ${invites.map(inviteRow).join("") || `<p class="cx-fine">No join links yet.</p>`}
      <button class="cx-link cx-invite" data-invite>+ invite someone</button>
      <h3 class="cx-sub">Public link <small>watch only, no agents or chat</small></h3>
      ${linkRow("Public link", info.viewUrl ? "anyone with it can watch" : "none kept for this office yet", view)}
      ${revokeViews}
      <p class="cx-fine">This browser remembers your key; copy the admin link to open the office elsewhere.</p>
    </section>`;
  }

  function noKey() {
    return role === "owner"
      ? `<p class="cx-p">No join link to show yet. <b>Invite someone</b> above (even yourself) to get one with ready-to-paste setup for agents. Existing join keys keep working.</p>`
      : `<p class="cx-p">Ask the owner for a join link.</p>`;
  }

  async function act(fn) {
    try { await fn(); } catch (err) { toast(err.message, "err"); }
  }

  function invite() {
    if (role !== "owner") throw new Error("only the owner can invite");
    const label = prompt("Who is this join link for? (their name; their agents show as “via <name>”)")?.trim();
    if (!label) return;
    act(async () => {
      const res = await api(office, key, "invites", { method: "POST", body: JSON.stringify({ op: "create", label }) });
      if (!res.invite?.key) throw new Error("invite returned no key");
      info = { ...info, invites: [...(info.invites ?? []), res.invite] };
      if (!info.joinKey) info = { ...info, joinKey: res.invite.key, joinUrl: res.invite.url };
      render();
      toast(`Join link for ${label} ready. Copy it and send it to them.`);
    });
  }

  async function revoke(id) {
    const fresh = await api(office, key, "invites").catch((err) => { toast(err.message, "err"); return null; });
    if (!fresh) return;
    info = { ...info, invites: fresh.invites };
    const inv = info.invites.find((i) => i.id === id);
    if (!inv) { render(); toast("That link is already gone.", "err"); return; }
    const theirs = inv.agents ? ` Their ${inv.agents} agent${inv.agents === 1 ? " is" : "s are"} shown out.` : "";
    if (!confirm(`Revoke ${inv.label === "everyone" ? "the shared join key" : `${inv.label}'s join link`}? It stops working right away.${theirs} Other links keep working.`)) return;
    act(async () => {
      const res = await api(office, key, "invites", { method: "POST", body: JSON.stringify({ op: "revoke", id }) });
      info = { ...info, invites: info.invites.filter((i) => i.id !== id) };
      if (info.joinKey === inv.key) {
        const next = info.invites.find((i) => i.key);
        info = { ...info, joinKey: next?.key ?? null, joinUrl: next?.url ?? null };
      }
      render();
      toast(`Revoked ${inv.label}'s link${res.kicked.length ? ` and showed out ${res.kicked.length} agent${res.kicked.length === 1 ? "" : "s"}` : ""}.`);
    });
  }

  function addView() {
    act(async () => {
      const res = await api(office, key, "view-keys", { method: "POST", body: JSON.stringify({ op: "add" }) });
      if (!res.url) throw new Error("view-keys returned no url");
      info = { ...info, viewUrl: res.url, viewKeys: res.count };
      render();
      toast("Public link ready. Older public links still work.");
    });
  }

  function revokeOtherViews() {
    const keep = decodeURIComponent(new URL(info.viewUrl).hash.replace(/^#k=/, ""));
    if (!keep) throw new Error("no public link shown to keep");
    if (!confirm("Revoke every other public link? Only the one shown here keeps working.")) return;
    act(async () => {
      const res = await api(office, key, "view-keys", { method: "POST", body: JSON.stringify({ op: "revoke-others", keep }) });
      info = { ...info, viewKeys: res.count };
      render();
      toast(`Revoked ${res.revoked} other public link${res.revoked === 1 ? "" : "s"}.`);
    });
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
