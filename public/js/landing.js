// Landing page: create an office with one click (POST /api/offices, no key) and drop straight into it via
// its owner link; the connect snippets are a generic explainer with copy buttons.
const land = document.querySelector(".land");
const form = document.getElementById("create-form");
const err = document.getElementById("create-err");

async function create(name) {
  const res = await fetch("/api/offices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(name ? { name } : {}),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  return body;
}

function selectText(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Browsers wrap after any hyphen, so "--key" could split into "-" / "-key"; flags stay whole.
function keepFlags(text) {
  return text.split(/(?<=^|\s)(--?[a-z][\w-]*)/i).filter(Boolean).map((piece) => {
    if (!piece.startsWith("-")) return piece;
    const flag = document.createElement("span");
    flag.className = "nb";
    flag.textContent = piece;
    return flag;
  });
}

// One block span per line gives wrapped lines a hanging indent; the copy text re-joins them with newlines.
function splitLines(code) {
  const lines = [document.createElement("span")];
  for (const node of [...code.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE) { lines.at(-1).append(node); continue; }
    node.textContent.split("\n").forEach((part, i) => {
      if (i > 0) lines.push(document.createElement("span"));
      if (part) lines.at(-1).append(...keepFlags(part));
    });
  }
  for (const line of lines) line.className = "ln";
  code.replaceChildren(...lines);
}

const linesOf = (code) => [...code.querySelectorAll(".ln")].map((l) => l.textContent).join("\n");

function copyButton(source, label, text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy";
  button.textContent = "Copy";
  button.setAttribute("aria-label", `Copy ${label}`);
  let timer;
  button.addEventListener("click", async () => {
    clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(text());
      button.textContent = "Copied";
      button.classList.add("done");
    } catch {
      selectText(source);
      button.textContent = "Press ⌘C";
    }
    timer = setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove("done");
    }, 1600);
  });
  return button;
}

for (const pre of land.querySelectorAll("pre")) {
  const code = pre.querySelector("code");
  const tab = document.getElementById(pre.closest("[role=tabpanel]").getAttribute("aria-labelledby"));
  splitLines(code);
  pre.append(copyButton(code, `${tab.textContent} snippet`, () => linesOf(code)));
}

const tabs = [...land.querySelectorAll("[role=tab]")];
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  }
}
for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
    selectTab(next);
    next.focus();
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "Creating…";
  err.hidden = true;
  try {
    const office = await create(form.elements.name.value.trim());
    if (!office.ownerUrl) throw new Error("the server didn't return an owner link");
    location.assign(office.ownerUrl);
  } catch (x) {
    err.textContent = `Couldn't create the office: ${x.message}`;
    err.hidden = false;
    button.disabled = false;
    button.textContent = "Create office";
  }
});
