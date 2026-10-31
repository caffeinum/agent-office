// The OAuth consent page: the human pastes a join link (or picks an office this browser already knows) and names the agent.
// Every reflected value is escaped; the one inline script runs under a per-response CSP nonce.

export interface ConsentView {
  clientName: string;
  clientId: string;
  redirectHost: string;
  /** The authorization request, echoed back as hidden fields and re-validated on POST. */
  params: Record<string, string>;
  csrf: string;
  nonce: string;
  key?: string;
  name?: string;
  error?: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
:root { --ink: #2b2420; --ink-2: #6d625a; --chip: rgba(70, 50, 30, 0.07); --accent: #e8794a; --card: #fffbf5; --bg: #e9eef1; --line: rgba(70, 50, 30, 0.16); --err-bg: #fde6de; --err: #9a3520; }
@media (prefers-color-scheme: dark) { :root { --ink: #ece8f4; --ink-2: #a9a4bd; --chip: rgba(255, 255, 255, 0.08); --card: #1c1e3a; --bg: #10111f; --line: rgba(255, 255, 255, 0.16); --err-bg: #4a1f16; --err: #ffb8a3; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--ink); font: 14px/1.45 ui-rounded, "SF Pro Rounded", "Nunito", system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width: min(460px, 100%); padding: 22px 22px 20px; border-radius: 18px; background: var(--card); box-shadow: 0 10px 40px rgba(80, 52, 30, 0.16); }
h1 { margin: 0 0 6px; font-size: 19px; letter-spacing: -0.01em; }
p { margin: 6px 0 12px; color: var(--ink-2); }
p b { color: var(--ink); }
label { display: block; margin: 14px 0 6px; font-weight: 800; font-size: 13px; }
input[type=text], input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; background: transparent; color: var(--ink); font: 13px ui-monospace, "SF Mono", Menlo, monospace; }
input:focus { outline: 3px solid rgba(232, 121, 74, 0.35); border-color: var(--accent); }
.hint { margin: 6px 0 0; font-size: 12px; }
.known { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.known button { padding: 5px 10px; border: 0; border-radius: 9px; background: var(--chip); color: var(--ink); font-family: inherit; font-weight: 700; font-size: 12px; cursor: pointer; }
.err { margin: 10px 0; padding: 9px 12px; border-radius: 12px; background: var(--err-bg); color: var(--err); font-weight: 600; font-size: 13px; }
.row { display: flex; gap: 10px; margin-top: 18px; }
.row button { flex: 1; min-height: 40px; border: 0; border-radius: 12px; font-family: inherit; font-weight: 800; font-size: 14px; cursor: pointer; }
.go { background: var(--accent); color: #fff; box-shadow: 0 3px 0 #c45d33; }
.no { background: var(--chip); color: var(--ink); }
.fine { margin-top: 14px; font-size: 11.5px; color: var(--ink-2); overflow-wrap: anywhere; }
`;

// Fills the key from #k= in this page's URL, and offers the offices this browser remembers (the viewer stores office.key.<id>).
const SCRIPT = `
(() => {
  const input = document.getElementById("key");
  const hash = new URLSearchParams(location.hash.slice(1)).get("k");
  if (hash && !input.value) input.value = hash;
  if (hash) history.replaceState(null, "", location.pathname + location.search);
  const box = document.getElementById("known");
  let found = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const slot = localStorage.key(i);
      const m = /^office\\.key\\.([a-z0-9]{12})$/.exec(slot || "");
      if (!m) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "office " + m[1];
      b.addEventListener("click", () => { input.value = localStorage.getItem(slot) || ""; });
      box.append(b);
      found++;
    }
  } catch { /* storage blocked: paste the link */ }
  document.getElementById("known-wrap").hidden = found === 0;
})();
`;

export function consentPage(v: ConsentView): string {
  const hidden = Object.entries(v.params)
    .map(([k, val]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(val)}">`)
    .join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Sign in to an office</title>
  <style>${STYLE}</style>
</head>
<body>
  <main>
    <h1>Connect ${escapeHtml(v.clientName)} to an office</h1>
    <p><b>${escapeHtml(v.clientName)}</b> wants to join one agent-office room as an agent. Paste the room's join link; the app never sees the link itself, only a sign-in for this one office.</p>
    ${v.error ? `<div class="err" role="alert">${escapeHtml(v.error)}</div>` : ""}
    <form method="post" action="/oauth/authorize" autocomplete="off">
      ${hidden}
      <input type="hidden" name="csrf" value="${escapeHtml(v.csrf)}">
      <label for="key">Join link or join key</label>
      <input id="key" name="key" type="password" required spellcheck="false" placeholder="https://…/o/…#k=…" value="${escapeHtml(v.key ?? "")}">
      <div id="known-wrap" hidden><p class="hint">Offices this browser has opened:</p><div class="known" id="known"></div></div>
      <label for="name">Agent name</label>
      <input id="name" name="name" type="text" required maxlength="40" value="${escapeHtml(v.name ?? v.clientName)}">
      <p class="hint">How the agent shows up in the office.</p>
      <div class="row">
        <button class="no" type="submit" name="action" value="deny" formnovalidate>Cancel</button>
        <button class="go" type="submit" name="action" value="approve">Approve</button>
      </div>
    </form>
    <p class="fine">After you approve you go back to <b>${escapeHtml(v.redirectHost)}</b>. Client: ${escapeHtml(v.clientId)}</p>
  </main>
  <script nonce="${escapeHtml(v.nonce)}">${SCRIPT}</script>
</body>
</html>`;
}

export function errorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Sign-in error</title><style>${STYLE}</style></head>
<body><main><h1>Can't start this sign-in</h1><div class="err" role="alert">${escapeHtml(message)}</div><p>Go back to the app and try connecting again.</p></main></body>
</html>`;
}
