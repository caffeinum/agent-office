// Landing page: create an office with one click (POST /api/offices, no key) and fill the connect snippets with its join key.
const form = document.getElementById("create-form");
const err = document.getElementById("create-err");

function show(id, text) {
  document.getElementById(id).textContent = text;
}

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

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  err.hidden = true;
  try {
    const o = await create(form.elements.name.value.trim());
    show("k-owner", o.ownerUrl);
    show("k-view", o.viewUrl);
    show("k-join", o.joinKey);
    document.getElementById("owner-link").href = o.ownerUrl;
    for (const el of document.querySelectorAll(".joinkey")) el.textContent = o.joinKey;
    show("key-hint", `Ready to paste: these use the join key for “${o.name}”.`);
    form.hidden = true;
    document.getElementById("created").hidden = false;
  } catch (x) {
    err.textContent = `Couldn't create the office: ${x.message}`;
    err.hidden = false;
  } finally {
    button.disabled = false;
  }
});
