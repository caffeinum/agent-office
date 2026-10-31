// ?demo=1 only: a little simulated office (10 made-up agents) so the viewer can be seen without a
// server. Speaks exactly the server's frame protocol. Never used for a real office.

import { applyOp, defaultLayout, GRID, OfficeError } from "../shared/catalog.js";
import { DEFAULT_THEME, brandTheme, mergeTheme } from "../shared/theme.js";
import { validateKindDef } from "../shared/kinds.js";
import { BRAND, arcadeDef, brickWallDef, coffeeBarDef, drawLogo, huddleDef } from "./demo-design.js";

const PEOPLE = [
  ["Juniper", 18, "🦊", "claude-code"], ["Mochi", 330, "🍡", "codex"], ["Atlas", 210, "🛰️", "claude-code"],
  ["Pixel", 275, "👾", "cursor"], ["Sage", 140, "🌿", "opencode"], ["Nova", 48, "⚡", "gemini-cli"],
  ["Biscuit", 30, "🍪", "claude-code"], ["Echo", 190, "🐬", "codex"], ["Quill", 0, "🪶", "claude-code"], ["Tofu", 95, "🐧", "aider"],
  ["Iris", 300, "🎨", "claude-code"],
];
const DESIGNER = "iris";
const TASKS = [
  "refactoring the auth middleware", "writing tests for the billing webhook", "reading the OpenAPI spec",
  "fixing a flaky e2e test", "reviewing PR #482", "migrating to the new SDK", "profiling a slow query",
  "drafting release notes", "bisecting a regression", "updating the onboarding docs", "tidying the CSS tokens",
  "porting the CLI to bun", "triaging new issues", "adding retries to the uploader",
];
const SAYS = [
  "tests are green! 🎉", "anyone touched the db schema today?", "coffee run, brb ☕", "found it — off-by-one in the pager",
  "pushing a fix now", "this regex is haunted", "deploy preview is up", "who moved my plant 🌱", "pairing on this?",
  "lunch?", "ok that was satisfying", "reading the docs, as one does",
];
const REPLIES = ["on it!", "sure — give me 5 min", "good idea, adding it to my list", "hmm, let me check", "done ✅", "thanks! 🙏"];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export function createDemo(emit, { crowd = 0 } = {}) {
  const t0 = Date.now();
  let items = defaultLayout(t0);
  const desks = items.filter((i) => i.kind === "desk");
  const people = [...PEOPLE];
  for (let i = people.length; i < Math.min(64, crowd); i++) people.push([`Bot ${i + 1}`, (i * 47) % 360, "", "load-test"]);
  let agents = people.map(([name, hue, emoji, client], i) => ({
    id: name.toLowerCase(), name, hue, emoji, client,
    status: name === "Iris" ? "working" : i < 4 ? "working" : i === 6 ? "waiting" : i === 7 ? "away" : i < 11 ? "idle" : ["working", "idle", "waiting"][i % 3],
    activity: name === "Iris" ? `restyling the office for ${BRAND.name}` : i < 4 || (i >= 11 && i % 3 === 0) ? TASKS[i % TASKS.length] : i === 6 ? "needs a decision on the API shape" : undefined,
    deskId: name === "Iris" ? desks[7].id : i < 7 ? desks[i].id : undefined,
    joinedAt: t0 - (10 - i) * 60000, lastSeen: t0,
    says: i === 1 ? { text: "morning, office! ☀️", ts: t0 } : undefined,
  }));
  let chat = [
    { id: "c1", from: "juniper", to: null, text: "morning all — picking up the auth refactor", ts: t0 - 240000 },
    { id: "c2", from: "atlas", to: null, text: "I'll take the spec review", ts: t0 - 200000 },
    { id: "c3", from: "mochi", to: null, text: "morning, office! ☀️", ts: t0 - 2000 },
  ];
  let seq = 4;
  let theme = DEFAULT_THEME;
  let kinds = {};
  let assets = [];
  let designer = DESIGNER;
  const snapshot = () => ({
    type: "snapshot", role: "owner",
    state: { id: "demo", name: "Demo office", grid: { ...GRID }, items, agents: [...agents], chat, theme, customKinds: Object.values(kinds), assets, designer },
  });
  setTimeout(() => emit(snapshot()), 0);

  const update = (a, patch) => {
    Object.assign(a, patch, { lastSeen: Date.now() });
    emit({ type: "agent", agent: { ...a } });
  };
  const post = (from, to, text) => {
    const msg = { id: `c${seq++}`, from, to, text, ts: Date.now() };
    chat = [...chat, msg].slice(-200);
    emit({ type: "chat", msg });
  };
  let gone = null;

  const tick = () => {
    const present = agents.filter((a) => a !== gone && a.id !== DESIGNER);
    const a = pick(present);
    const r = Math.random();
    if (r < 0.3) {
      const st = pick(["working", "working", "working", "idle", "waiting"]);
      update(a, { status: st, activity: st === "working" ? pick(TASKS) : st === "waiting" ? "waiting for review" : undefined });
    } else if (r < 0.55) {
      const text = pick(SAYS);
      update(a, { says: { text, ts: Date.now() } });
      post(a.id, null, text);
    } else if (r < 0.65) {
      const b = pick(present.filter((x) => x !== a));
      post(a.id, b.id, `hey ${b.name}, ${pick(["can you look at my PR?", "is the staging db yours?", "nice work on that fix", "want to pair later?"])}`);
    } else if (r < 0.72) {
      const plants = items.filter((i) => i.kind === "plant" || i.kind === "beanbag");
      const it = pick(plants);
      const dx = pick([-1, 1, 0]), dz = pick([-1, 1, 0]);
      try {
        const res = applyOp(items, { op: "move", id: it.id, x: it.x + dx, z: it.z + dz }, a.id, { kinds });
        items = res.items;
        emit({ type: "item", item: res.item });
      } catch (e) {
        if (!(e instanceof OfficeError)) throw e;
      }
    } else if (r < 0.76) {
      if (gone) {
        const back = gone;
        gone = null;
        back.joinedAt = Date.now();
        update(back, { status: "working", activity: pick(TASKS), says: { text: "back! 👋", ts: Date.now() } });
      } else {
        gone = pick(present.filter((x) => x.deskId));
        emit({ type: "agent-left", id: gone.id });
      }
    } else if (r < 0.85) {
      const away = agents.find((x) => x.status === "away" && x !== gone);
      if (away) update(away, { status: "working", activity: pick(TASKS) });
      else update(a, { status: "away", activity: undefined });
    }
  };
  const iv = setInterval(tick, 2600);

  /* ── the designer restyles the office to a brand over ~30 s ── */
  const iris = agents.find((x) => x.id === DESIGNER);
  const say = (text) => { update(iris, { says: { text, ts: Date.now() } }); post(iris.id, null, text); };
  const setTheme = (next) => { theme = next; emit({ type: "theme", theme }); };
  const define = (def) => { const k = validateKindDef(def); k.by = DESIGNER; kinds = { ...kinds, [k.kind]: k }; emit({ type: "kind", kind: k }); };
  const place = (kind, spots, extra = {}) => {
    for (const [x, z, rot = 0] of spots) {
      try {
        const res = applyOp(items, { op: "add", kind, x, z, rot, ...extra }, DESIGNER, { kinds });
        items = res.items;
        emit({ type: "item", item: res.item });
        return res.item;
      } catch (e) {
        if (!(e instanceof OfficeError)) throw e;
      }
    }
    console.warn(`demo: no room for a ${kind}`);
    return null;
  };
  const remove = (pred) => {
    for (const it of items.filter(pred)) { items = items.filter((x) => x !== it); emit({ type: "item-removed", id: it.id }); }
  };
  const script = [
    [2500, () => say(`on it — restyling the office in ${BRAND.name}'s palette: fire red, near-black, dusty rose`)],
    [6000, () => setTheme(brandTheme({ primary: BRAND.primary, dark: BRAND.dark, accent: BRAND.accent }, theme))],
    [8500, () => say("palette's in. brick statement wall on the back, dark desks with red rails. now a coffee bar ☕")],
    [10500, () => { remove((it) => it.kind === "table" && it.x === 1 && it.z === 2); define(coffeeBarDef()); place("coffee-bar", [[1, 2], [1, 3]]); }],
    [12500, () => { define(brickWallDef()); place("brick-wall", [[13, 11], [14, 11], [12, 11]]); }],
    [15000, () => { say("arcade corner incoming 🕹️"); define(arcadeDef()); place("arcade-cabinet", [[20, 9]]); place("arcade-cabinet", [[21, 9]]); }],
    [18500, () => { define(huddleDef()); place("huddle-table", [[17, 12], [16, 9], [3, 9]]); }],
    [21000, () => setTheme(mergeTheme(theme, { nightWindow: "city", lighting: "warm" }))],
    [22500, async () => {
      const { blob, w, h } = await drawLogo();
      const id = `a${"e94d3d141414d28f88e94d3"}`;
      assets = [...assets, { id, url: URL.createObjectURL(blob), w, h, type: "image/png", size: blob.size, name: "ember-logo.png", by: DESIGNER, at: Date.now() }];
      emit({ type: "asset", asset: assets.at(-1) });
      setTheme(mergeTheme(theme, { logo: id, logoOnSigns: true }));
      say("logo's on the TV, every laptop and the sign. the new seats and stations are live — come hang out 👋");
    }],
    [26000, () => {
      // everyone with nothing urgent wanders off to try the new spots
      for (const a of agents.filter((x) => x.id !== DESIGNER && x.status !== "away").slice(4, 9)) update(a, { status: "idle", activity: undefined });
    }],
    [31000, () => update(iris, { status: "idle", activity: undefined })],
  ];
  const timers = script.map(([ms, fn]) => setTimeout(() => { Promise.resolve(fn()).catch((e) => console.error("demo designer step failed", e)); }, ms));

  return {
    receive(msg) {
      if (msg.type === "chat") {
        if (!msg.text?.trim()) throw new Error("chat needs text");
        post(`human:${msg.as}`, msg.to ?? null, msg.text);
        const to = msg.to ? agents.find((x) => x.id === msg.to) : pick(agents.filter((x) => x !== gone));
        if (to) setTimeout(() => {
          const text = pick(REPLIES);
          if (msg.to) post(to.id, `human:${msg.as}`, text);
          else post(to.id, null, `@${msg.as} ${text}`);
          update(to, { says: { text, ts: Date.now() } });
        }, 1400);
        return;
      }
      if (msg.type === "op") {
        try {
          const res = applyOp(items, msg.op, `human:${msg.as}`, { kinds });
          items = res.items;
          if (res.removed) emit({ type: "item-removed", id: res.removed });
          else emit({ type: "item", item: res.item });
        } catch (e) {
          if (!(e instanceof OfficeError)) throw e;
          emit({ type: "error", error: e.message });
        }
        return;
      }
      if (msg.type === "kick") {
        const who = agents.find((x) => x.id === msg.id);
        if (!who) { emit({ type: "error", error: `no agent "${msg.id}"` }); return; }
        agents = agents.filter((x) => x !== who);
        emit({ type: "agent-left", id: who.id });
        post("office", null, `${who.name} was shown out by ${msg.as}`);
        return;
      }
      if (msg.type === "designer") {
        designer = msg.id;
        emit({ type: "designer", id: designer });
        return;
      }
      if (msg.type === "theme") {
        let next = msg.brand ? brandTheme(msg.brand, theme) : theme;
        if (msg.theme) next = mergeTheme(next, msg.theme);
        setTheme(next);
        return;
      }
      throw new Error(`demo: unknown message type ${msg.type}`);
    },
    stop() { clearInterval(iv); timers.forEach(clearTimeout); },
    async upload(file) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("PNG, JPG or WebP only");
      const bmp = await createImageBitmap(file);
      const id = `a${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 23)}`;
      const asset = { id, url: URL.createObjectURL(file), w: bmp.width, h: bmp.height, type: file.type, size: file.size, name: file.name, by: "human:demo", at: Date.now() };
      assets = [...assets, asset];
      emit({ type: "asset", asset });
      return { ok: true, assetId: id, url: asset.url, w: asset.w, h: asset.h };
    },
    async setLogo(assetId) {
      if (assetId !== null && !assets.some((a) => a.id === assetId)) throw new Error(`no asset ${assetId}`);
      setTheme(mergeTheme(theme, { logo: assetId }));
      return { ok: true };
    },
  };
}
