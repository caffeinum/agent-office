// Office design over the wire: theme, custom kinds, uploads + asset serving, designer, ws deltas, migration.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sniffImage, ASSETS_MAX, ASSETS_TOTAL_MAX, ASSET_BYTES_MAX } from "../src/images";
import { DEFAULT_THEME } from "../src/shared/design";
import { defaultLayout } from "../src/shared/catalog";
import { SCHEMA_VERSION, type Office } from "../src/office";
import { b64, call, createOffice, fakeImage, join, openWs, ORIGIN, type Created } from "./helpers";

const stubOf = (id: string) => env.OFFICE.get(env.OFFICE.idFromName(id));
const BRAND = { primary: "#e94d3d", dark: "#141414", accent: "#d28f88" };

const arcade = (over: Record<string, unknown> = {}) => ({
  kind: "arcade-cabinet",
  label: "Arcade cabinet",
  footprint: { w: 1, d: 1 },
  boxes: [
    { x: 2, y: 0, z: 2, w: 12, h: 40, d: 12, color: "#141414" },
    { x: 3, y: 24, z: 13, w: 10, h: 10, d: 1, color: "#222222", material: "screen" },
  ],
  stations: [{ x: 8, z: 24, rot: 180, activity: "play" }],
  screen: true,
  ...over,
});

async function rawUpload(o: Created, bytes: Uint8Array, type: string, opts: { key?: string; token?: string; filename?: string } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? o.joinKey}`, "content-type": type };
  if (opts.token) headers["x-agent-token"] = opts.token;
  const res = await SELF.fetch(`${ORIGIN}/api/o/${o.id}/upload?filename=${encodeURIComponent(opts.filename ?? "logo.png")}`, { method: "POST", headers, body: bytes });
  return { status: res.status, body: (await res.json()) as any };
}

describe("image sniffing (no image libs)", () => {
  it("reads PNG, JPEG and all three WebP headers", () => {
    expect(sniffImage(fakeImage.png(640, 480))).toEqual({ type: "image/png", w: 640, h: 480 });
    expect(sniffImage(fakeImage.jpeg(300, 200))).toEqual({ type: "image/jpeg", w: 300, h: 200 });
    expect(sniffImage(fakeImage.webpX(1024, 7))).toEqual({ type: "image/webp", w: 1024, h: 7 });
    expect(sniffImage(fakeImage.webpL(33, 44))).toEqual({ type: "image/webp", w: 33, h: 44 });
    expect(sniffImage(fakeImage.webpLossy(120, 90))).toEqual({ type: "image/webp", w: 120, h: 90 });
  });

  it("refuses bad magic, lies, oversize and huge dimensions", () => {
    expect(() => sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toThrow(/magic bytes/);
    expect(() => sniffImage(new TextEncoder().encode("GIF89a........................"))).toThrow(/not a PNG, JPEG or WebP/);
    expect(() => sniffImage(fakeImage.png(10, 10), "image/jpeg")).toThrow(/says image\/jpeg but the bytes are image\/png/);
    expect(() => sniffImage(fakeImage.png(1025, 10))).toThrow(/1025×10 pixels, max 1024/);
    expect(() => sniffImage(fakeImage.jpeg(10, 2000))).toThrow(/max 1024/);
    expect(() => sniffImage(fakeImage.webpX(4000, 4000))).toThrow(/max 1024/);
    expect(() => sniffImage(fakeImage.png(0, 10))).toThrow(/0×10/);
    expect(() => sniffImage(fakeImage.png(10, 10).slice(0, 20))).toThrow(/truncated/);
    expect(() => sniffImage(new Uint8Array(ASSET_BYTES_MAX + 1))).toThrow(/max 524288/);
    expect(() => sniffImage(new Uint8Array(0))).toThrow(/empty/);
  });
});

describe("theme over REST + ws", () => {
  it("new offices start with the default theme; brand derives a full theme and broadcasts it", async () => {
    const o = await createOffice();
    const a = await join(o, "Designer");
    const t = { token: a.agentToken };
    const got = await call(o, "theme_get", {}, { ...t, method: "GET" });
    expect(got.status).toBe(200);
    expect(got.body.theme).toEqual(DEFAULT_THEME);
    expect(got.body.assets).toEqual([]);

    const viewer = await openWs(o, o.viewKey);
    const snap = await viewer.next((f) => f.type === "snapshot");
    expect(snap.state.theme).toEqual(DEFAULT_THEME);
    expect(snap.state.customKinds).toEqual([]);
    expect(snap.state.assets).toEqual([]);
    expect(snap.state.designer).toBeNull();

    const set = await call(o, "theme_set", { brand: BRAND, theme: { floor: { material: "wood" } } }, t);
    expect(set.status).toBe(200);
    expect(set.body.theme.accents).toEqual(["#e94d3d", "#d28f88", "#141414"]);
    expect(set.body.theme.floor.material).toBe("wood"); // the patch applies on top of the brand theme
    const frame = await viewer.next((f) => f.type === "theme");
    expect(frame.theme).toEqual(set.body.theme);

    const part = await call(o, "theme_set", { theme: { lighting: "cool", walls: { accent: null } } }, t);
    expect(part.body.theme).toMatchObject({ lighting: "cool", accents: ["#e94d3d", "#d28f88", "#141414"] });
    expect(part.body.theme.walls.accent).toBeNull();
    viewer.ws.close();
  });

  it("validates and guards", async () => {
    const o = await createOffice();
    const a = await join(o, "Ada");
    const t = { token: a.agentToken };
    expect((await call(o, "theme_set", {}, t)).body.error).toMatch(/needs `theme`/);
    expect((await call(o, "theme_set", { theme: { floor: { material: "lava" } } }, t)).status).toBe(400);
    expect((await call(o, "theme_set", { brand: { primary: "red" } }, t)).status).toBe(400);
    expect((await call(o, "theme_set", { theme: { logo: "a0123456789abcdef0123456" } }, t)).body.error).toMatch(/no asset/);
    expect((await call(o, "theme_set", { theme: { lighting: "cool" } })).status).toBe(401); // joinKey without joining
    expect((await call(o, "theme_set", { theme: { lighting: "cool" } }, { key: o.viewKey })).status).toBe(403);
    const owner = await call(o, "theme_set", { theme: { lighting: "cool" } }, { key: o.ownerKey }); // owner needs no agent
    expect(owner.status).toBe(200);
    expect(owner.body.theme.lighting).toBe("cool");
  });

  it("the owner restyles over the socket", async () => {
    const o = await createOffice();
    const owner = await openWs(o, o.ownerKey);
    await owner.next((f) => f.type === "snapshot");
    owner.ws.send(JSON.stringify({ type: "theme", theme: { nightWindow: "stars" }, as: "Aleks" }));
    expect((await owner.next((f) => f.type === "theme")).theme.nightWindow).toBe("stars");
    owner.ws.send(JSON.stringify({ type: "theme", theme: { lighting: "disco" } }));
    expect((await owner.next((f) => f.type === "error")).error).toMatch(/lighting/);
    owner.ws.close();
  });
});

describe("custom kinds", () => {
  it("define → place → redefine live → refuse delete in use → delete", async () => {
    const o = await createOffice();
    const a = await join(o, "Builder");
    const t = { token: a.agentToken };
    const viewer = await openWs(o, o.viewKey);
    await viewer.next((f) => f.type === "snapshot");

    const def = await call(o, "define_kind", arcade(), t);
    expect(def.status).toBe(200);
    expect(def.body.kind).toMatchObject({ kind: "arcade-cabinet", custom: true, boxes: 2, screen: true });
    const kf = await viewer.next((f) => f.type === "kind");
    expect(kf.kind).toMatchObject({ kind: "arcade-cabinet", w: 1, d: 1, by: a.agent.id });
    expect(kf.kind.boxes).toHaveLength(2);

    const add = await call(o, "add", { kind: "arcade-cabinet", x: 22, z: 10 }, t);
    expect(add.status).toBe(200);
    expect(add.body.item.id).toBe("arcade-cabinet-1");

    const kinds = await call(o, "kinds", {}, { method: "GET" });
    expect(kinds.body.custom["arcade-cabinet"]).toMatchObject({ boxes: 2, height: 40, stations: [{ activity: "play" }] });
    expect(kinds.body.kinds.sofa.seats).toHaveLength(3);
    const full = await SELF.fetch(`${ORIGIN}/api/o/${o.id}/kinds?kind=arcade-cabinet`, { headers: { authorization: `Bearer ${o.joinKey}` } });
    expect(((await full.json()) as any).boxes).toHaveLength(2);

    const look = await call(o, "look", {}, t);
    expect(look.body.stations.some((s: string) => s.startsWith("arcade-cabinet-1:t0 play"))).toBe(true);
    expect(look.body.seats.some((s: string) => s.startsWith("sofa-1:s0"))).toBe(true);
    expect(look.body.design.customKinds).toBe(1);
    expect(look.body.design.stationsByActivity.play).toBe(1);

    const redo = await call(o, "define_kind", arcade({ label: "Neon arcade", boxes: [{ x: 0, y: 0, z: 0, w: 16, h: 48, d: 16, color: "#e94d3d", emissive: true }] }), t);
    expect(redo.status).toBe(200);
    expect(redo.body.updated).toEqual(["arcade-cabinet-1"]);
    expect((await viewer.next((f) => f.type === "kind" && f.kind.label === "Neon arcade")).kind.boxes[0].emissive).toBe(true);

    // a bigger footprint would collide with the wall's edge → refused, old kind stays
    const tooBig = await call(o, "define_kind", arcade({ footprint: { w: 3, d: 1 } }), t);
    expect(tooBig.status).toBe(409);
    expect(tooBig.body.error).toMatch(/can't redefine arcade-cabinet.*out of bounds/);

    const busy = await call(o, "delete_kind", { kind: "arcade-cabinet" }, t);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/in use by arcade-cabinet-1/);
    await call(o, "remove", { id: "arcade-cabinet-1" }, t);
    const del = await call(o, "delete_kind", { kind: "arcade-cabinet" }, t);
    expect(del.body).toEqual({ ok: true, deleted: "arcade-cabinet" });
    expect((await viewer.next((f) => f.type === "kind-removed")).kind).toBe("arcade-cabinet");
    expect((await call(o, "add", { kind: "arcade-cabinet", x: 22, z: 10 }, t)).body.error).toMatch(/unknown kind/);
    viewer.ws.close();
  });

  it("refuses built-in names, bad boxes, and more than 64 kinds", async () => {
    const o = await createOffice();
    const a = await join(o, "Builder");
    const t = { token: a.agentToken };
    expect((await call(o, "define_kind", arcade({ kind: "sofa" }), t)).body.error).toMatch(/built-in/);
    expect((await call(o, "define_kind", arcade({ boxes: [{ x: 10, y: 0, z: 0, w: 10, h: 4, d: 4, color: "#000000" }] }), t)).body.error).toMatch(/sticks out/);
    expect((await call(o, "delete_kind", { kind: "nope-kind" }, t)).status).toBe(404);
    await runInDurableObject(stubOf(o.id), async (inst: Office) => {
      const ks: Record<string, unknown> = {};
      for (let i = 0; i < 64; i++) ks[`k-${i}`] = { kind: `k-${i}`, label: "k", w: 1, d: 1, layer: "object", boxes: [], seats: [], stations: [], textable: false, screen: false, custom: true };
      (inst as any).customKinds = ks;
    });
    const r = await call(o, "define_kind", arcade(), t);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already has 64 custom kinds/);
  });

  it("a big model fits through REST and MCP body limits", async () => {
    const o = await createOffice();
    const a = await join(o, "Builder");
    const boxes = Array.from({ length: 512 }, (_, i) => ({ x: i % 32, y: Math.floor(i / 32), z: 0, w: 1, h: 1, d: 1, color: "#123456", material: "glossy" }));
    const r = await call(o, "define_kind", arcade({ footprint: { w: 2, d: 1 }, boxes }), { token: a.agentToken });
    expect(r.status).toBe(200);
    expect(r.body.kind.boxes).toBe(512);
  });
});

describe("uploads + asset serving", () => {
  it("raw REST upload → served with long cache, type and nosniff; dedupes; 304 on etag", async () => {
    const o = await createOffice();
    const a = await join(o, "Up");
    const viewer = await openWs(o, o.viewKey);
    await viewer.next((f) => f.type === "snapshot");
    const png = fakeImage.png(256, 128, 100);
    const up = await rawUpload(o, png, "image/png", { token: a.agentToken });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ ok: true, w: 256, h: 128, type: "image/png", size: png.length });
    expect(up.body.assetId).toMatch(/^a[0-9a-f]{23}$/);
    expect(up.body.url).toBe(`${ORIGIN}/o/${o.id}/assets/${up.body.assetId}`);
    const af = await viewer.next((f) => f.type === "asset");
    expect(af.asset).toMatchObject({ id: up.body.assetId, url: `/o/${o.id}/assets/${up.body.assetId}`, w: 256, h: 128 });

    const res = await SELF.fetch(up.body.url); // no key needed: content-hash ids
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    const again = await SELF.fetch(up.body.url, { headers: { "if-none-match": res.headers.get("etag")! } });
    expect(again.status).toBe(304);
    expect((await SELF.fetch(`${ORIGIN}/o/${o.id}/assets/a00000000000000000000000`)).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/o/${o.id}/assets/${up.body.assetId}`, { method: "POST" })).status).toBe(405);

    const dup = await rawUpload(o, png, "image/png", { token: a.agentToken });
    expect(dup.body).toMatchObject({ assetId: up.body.assetId, deduped: true });
    viewer.ws.close();
  });

  it("refuses bad magic bytes, oversize bodies, huge images, mismatched types", async () => {
    const o = await createOffice();
    const a = await join(o, "Up");
    const t = { token: a.agentToken };
    const svg = await rawUpload(o, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png", t);
    expect(svg.status).toBe(415);
    expect(svg.body.error).toMatch(/magic bytes/);
    const big = await rawUpload(o, fakeImage.png(10, 10, ASSET_BYTES_MAX), "image/png", t);
    expect(big.status).toBe(413);
    const huge = await rawUpload(o, fakeImage.png(2048, 2048), "image/png", t);
    expect(huge.status).toBe(415);
    expect(huge.body.error).toMatch(/2048×2048 pixels, max 1024/);
    const lie = await call(o, "upload", { filename: "x.webp", contentType: "image/webp", base64: b64(fakeImage.jpeg(10, 10)) }, t);
    expect(lie.status).toBe(415);
    expect(lie.body.error).toMatch(/bytes are image\/jpeg/);
    expect((await call(o, "upload", { filename: "x.png", contentType: "image/gif", base64: "AAAA" }, t)).status).toBe(400);
    expect((await call(o, "upload", { filename: "x.png", contentType: "image/png", base64: "!!!not base64" }, t)).status).toBe(400);
    expect((await rawUpload(o, fakeImage.png(10, 10), "image/png", { key: o.viewKey })).status).toBe(403);
    expect((await rawUpload(o, fakeImage.png(10, 10), "image/png")).status).toBe(401);
    expect((await rawUpload(o, fakeImage.png(10, 10), "image/png", { key: o.ownerKey })).status).toBe(200); // owner, no agent
  });

  it("generic content-types (curl's default, octet-stream) trust the magic bytes; a declared other type is still refused", async () => {
    const o = await createOffice();
    const a = await join(o, "Curl");
    const t = { token: a.agentToken };
    expect((await rawUpload(o, fakeImage.png(12, 12), "application/x-www-form-urlencoded", t)).body.type).toBe("image/png");
    expect((await rawUpload(o, fakeImage.jpeg(13, 13), "application/octet-stream", t)).body.type).toBe("image/jpeg");
    expect((await rawUpload(o, fakeImage.png(14, 14), "text/html", t)).status).toBe(415);
  });

  it("JSON base64 upload + set_logo puts it in the theme; the logo can't be deleted while in use", async () => {
    const o = await createOffice();
    const a = await join(o, "Up");
    const t = { token: a.agentToken };
    const up = await call(o, "upload", { filename: "logo.webp", contentType: "image/webp", base64: `data:image/webp;base64,${b64(fakeImage.webpL(64, 64))}` }, t);
    expect(up.status).toBe(200);
    const id = up.body.assetId;
    expect((await call(o, "set_logo", { assetId: "a00000000000000000000000" }, t)).status).toBe(404);
    const logo = await call(o, "set_logo", { assetId: id, onSigns: true }, t);
    expect(logo.body.theme).toMatchObject({ logo: id, logoOnSigns: true });
    expect((await call(o, "delete_asset", { assetId: id }, t)).status).toBe(409);
    // a brand re-theme keeps the logo
    expect((await call(o, "theme_set", { brand: BRAND }, t)).body.theme.logo).toBe(id);
    await call(o, "set_logo", { assetId: null }, t);
    expect((await call(o, "delete_asset", { assetId: id }, t)).body).toEqual({ ok: true, deleted: id });
    expect((await SELF.fetch(`${ORIGIN}/o/${o.id}/assets/${id}`)).status).toBe(404);
    const got = await call(o, "theme_get", {}, t);
    expect(got.body.assets).toEqual([]);
  });

  it(`quota: ${ASSETS_MAX} assets and ${ASSETS_TOTAL_MAX} bytes per office`, async () => {
    const o = await createOffice();
    const a = await join(o, "Up");
    const t = { token: a.agentToken };
    await runInDurableObject(stubOf(o.id), async (inst: Office) => {
      const m = (inst as any).assets as Map<string, unknown>;
      for (let i = 0; i < ASSETS_MAX; i++) m.set(`a${String(i).padStart(23, "0")}`, { id: "x", url: "", name: "x", type: "image/png", w: 1, h: 1, size: 10, by: "t", at: 0 });
    });
    const full = await rawUpload(o, fakeImage.png(3, 3), "image/png", t);
    expect(full.status).toBe(409);
    expect(full.body.error).toMatch(/32 images already/);
    await runInDurableObject(stubOf(o.id), async (inst: Office) => {
      const m = (inst as any).assets as Map<string, unknown>;
      m.clear();
      m.set("a00000000000000000000001", { id: "x", url: "", name: "x", type: "image/png", w: 1, h: 1, size: ASSETS_TOTAL_MAX - 50, by: "t", at: 0 });
    });
    const bytes = await rawUpload(o, fakeImage.png(4, 4, 30), "image/png", t);
    expect(bytes.status).toBe(409);
    expect(bytes.body.error).toMatch(/max 8388608/);
  });

  it("assets survive a reload of the office from storage", async () => {
    const o = await createOffice();
    const up = await rawUpload(o, fakeImage.jpeg(20, 10), "image/jpeg", { key: o.ownerKey, filename: "../../etc/passwd" });
    expect(up.status).toBe(200);
    const meta = await runInDurableObject(stubOf(o.id), async (inst: Office) => {
      (inst as any).assets.clear();
      await (inst as any).load();
      return [...(inst as any).assets.values()];
    });
    expect(meta).toHaveLength(1);
    expect(meta[0]).toMatchObject({ id: up.body.assetId, name: "passwd", type: "image/jpeg", w: 20, h: 10 });
  });
});

describe("designer", () => {
  it("owner marks an agent as designer: ws delta, look, cleared when the agent leaves", async () => {
    const o = await createOffice();
    const d = await join(o, "Office Designer", { client: "claude-code" });
    const owner = await openWs(o, o.ownerKey);
    await owner.next((f) => f.type === "snapshot");
    expect((await call(o, "designer", { id: "Office Designer" })).status).toBe(403); // joinKey can't
    owner.ws.send(JSON.stringify({ type: "designer", id: "Office Designer" }));
    expect((await owner.next((f) => f.type === "designer")).id).toBe(d.agent.id);
    const look = await call(o, "look", {}, { token: d.agentToken });
    expect(look.body.designer).toBe(d.agent.id);
    expect(look.body.you.designer).toBe(true);
    const again = await call(o, "join", { name: "Office Designer", client: "claude-code" }, { token: d.agentToken });
    expect(again.body.next).toMatch(/office-designer prompt/);
    await call(o, "leave", {}, { token: again.body.agentToken });
    expect((await owner.next((f) => f.type === "designer" && f.id === null)).id).toBeNull();
    owner.ws.close();
  });

  it("owner REST sets and clears", async () => {
    const o = await createOffice();
    const d = await join(o, "Des");
    const r = await call(o, "designer", { id: d.agent.id }, { key: o.ownerKey });
    expect(r.body).toEqual({ ok: true, designer: d.agent.id });
    expect((await call(o, "designer", { id: "ghost" }, { key: o.ownerKey })).status).toBe(404);
    expect((await call(o, "designer", { id: null }, { key: o.ownerKey })).body.designer).toBeNull();
  });
});

describe("hygiene", () => {
  it("labels, sign text and names with control or bidi-override characters are refused", async () => {
    const o = await createOffice();
    const a = await join(o, "Clean");
    const t = { token: a.agentToken };
    expect((await call(o, "define_kind", arcade({ label: "evil\u202Eedoc" }), t)).status).toBe(400);
    expect((await call(o, "define_kind", arcade({ label: "nul\u0000" }), t)).status).toBe(400);
    expect((await call(o, "add", { kind: "sign", x: 4, z: 13, text: "hi\u202Ethere" }, t)).status).toBe(400);
    expect((await call(o, "add", { kind: "sign", x: 4, z: 13, text: "two\nlines" }, t)).status).toBe(200);
    expect((await call(o, "join", { name: "spoof\u202Eer" })).status).toBe(400);
  });

  it('chat to "room" posts to the room; an unknown recipient explains how to reach the room', async () => {
    const o = await createOffice();
    const a = await join(o, "Talker");
    const t = { token: a.agentToken };
    const sent = await call(o, "chat_send", { to: "room", text: "hello all" }, t);
    expect(sent.status).toBe(200);
    const miss = await call(o, "chat_send", { to: "nobody", text: "hi" }, t);
    expect(miss.status).toBe(404);
    expect(miss.body.error).toMatch(/omit "to"/);
  });

  it("a flooding owner socket gets one visible rate-limit error instead of silent drops", async () => {
    const o = await createOffice();
    const { ws, frames, next } = await openWs(o, o.ownerKey);
    await next((f) => f.type === "snapshot");
    for (let i = 0; i < 40; i++) ws.send(JSON.stringify({ type: "theme", theme: { lighting: i % 2 ? "cool" : "warm" } }));
    const err = await next((f) => f.type === "error" && /rate limited/.test(f.error));
    expect(err.retryAfter).toBeGreaterThan(0);
    expect(frames.filter((f) => f.type === "error" && /rate limited/.test(f.error))).toHaveLength(1);
    ws.close();
  });
});

describe("migration", () => {
  it("a v1 office (no schema, theme, kinds or assets table) loads with the default theme and loses nothing", async () => {
    const o = await createOffice("Old Office");
    const a = await join(o, "Old Timer");
    await call(o, "say", { text: "from before the upgrade" }, { token: a.agentToken });
    const before = await call(o, "look", {}, { token: a.agentToken });
    const after = await runInDurableObject(stubOf(o.id), async (inst: Office, state) => {
      // rewind storage to what v1 wrote
      await state.storage.delete(["schema", "theme"]);
      state.storage.sql.exec("DROP TABLE assets");
      expect(await state.storage.get("schema")).toBeUndefined();
      const fresh = inst as any;
      fresh.items.clear();
      fresh.agents.clear();
      fresh.chat = [];
      fresh.theme = null;
      await fresh.load();
      return { schema: await state.storage.get("schema"), theme: await state.storage.get("theme"), items: fresh.items.size, agents: fresh.agents.size, chat: fresh.chat.length };
    });
    expect(after.schema).toBe(SCHEMA_VERSION);
    expect(after.theme).toEqual(DEFAULT_THEME);
    expect(after.items).toBe(defaultLayout(0).length);
    expect(after.agents).toBe(1);
    expect(after.chat).toBe(1);
    const look = await call(o, "look", {}, { token: a.agentToken });
    expect([...look.body.items].sort()).toEqual([...before.body.items].sort());
    expect(look.body.design.theme).toMatch(/wood floor/);
    const t = await call(o, "theme_get", {}, { token: a.agentToken });
    expect(t.body.theme).toEqual(DEFAULT_THEME);
    expect(t.body.assets).toEqual([]);
  });

  it("a stored theme from before a field existed is filled with that field's default and written back", async () => {
    const o = await createOffice();
    const a = await join(o, "Theme Keeper");
    await call(o, "theme_set", { theme: { floor: { material: "tile", color: "#334455" } } }, { token: a.agentToken });
    const out = await runInDurableObject(stubOf(o.id), async (inst: Office, state) => {
      const stored = (await state.storage.get("theme")) as any;
      const { trim: _trim, ...walls } = stored.walls;
      const { nightWindow: _nw, ...rest } = stored;
      await state.storage.put("theme", { ...rest, walls });
      await (inst as any).load();
      return { mem: (inst as any).theme, disk: await state.storage.get("theme") };
    });
    expect(out.mem.floor).toEqual({ material: "tile", color: "#334455" });
    expect(out.mem.walls.trim).toBe(DEFAULT_THEME.walls.trim);
    expect(out.mem.nightWindow).toBe(DEFAULT_THEME.nightWindow);
    expect(out.disk).toEqual(out.mem);
  });

  it("refuses storage from a newer build instead of guessing", async () => {
    const o = await createOffice();
    const err = await runInDurableObject(stubOf(o.id), async (inst: Office, state) => {
      await state.storage.put("schema", SCHEMA_VERSION + 1);
      try {
        await (inst as any).load();
        return null;
      } catch (e) {
        return (e as Error).message;
      } finally {
        await state.storage.put("schema", SCHEMA_VERSION);
      }
    });
    expect(err).toMatch(/schema 3, this build understands up to 2/);
  });
});
