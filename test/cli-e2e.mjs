// End-to-end: boots `wrangler dev`, then drives the real CLI (bin/agent-office) against it.
// Usage: node test/cli-e2e.mjs [--url http://127.0.0.1:8799]  (without --url it starts wrangler dev itself)
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "bin", "agent-office");
const urlFlag = process.argv.indexOf("--url");
const port = Number(process.env.PORT ?? 8799);
const url = urlFlag > 0 ? process.argv[urlFlag + 1] : `http://127.0.0.1:${port}`;
const adminKey = /ADMIN_KEY=(.*)/.exec(readFileSync(join(root, ".dev.vars"), "utf8"))?.[1]?.trim();
assert.ok(adminKey, "ADMIN_KEY missing from .dev.vars");

let dev;
async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not come up on ${url}`);
}

const cfgDir = mkdtempSync(join(tmpdir(), "agent-office-cli-"));
const run = (...args) =>
  execFileSync(process.execPath, [cli, ...args], { env: { ...process.env, AGENT_OFFICE_CONFIG_DIR: cfgDir }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const runJson = (...args) => JSON.parse(run(...args, "--json"));

/** A real, decodable PNG: a w×h RGBA image filled by fn(x, y) → [r, g, b, a]. */
function makePng(w, h, fn) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(fn(x, y), y * (w * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const runFail = (...args) => {
  try {
    run(...args);
  } catch (e) {
    return { code: e.status, stderr: e.stderr };
  }
  throw new Error(`expected failure: ${args.join(" ")}`);
};

try {
  if (urlFlag < 0) {
    dev = spawn(join(root, "node_modules", ".bin", "wrangler"), ["dev", "--port", String(port), "--ip", "127.0.0.1"], { cwd: root, stdio: "ignore" });
  }
  await waitHealthy();

  assert.match(runFail("create", url, "--admin-key", "wrong").stderr, /ADMIN_KEY/);
  const office = runJson("create", url, "--admin-key", adminKey, "--name", "CLI Office");
  assert.match(office.joinKey, /^[a-z0-9]{12}\./);

  const joined = runJson("join", url, "--key", office.joinKey, "--name", "cli-bot", "--client", "e2e");
  assert.ok(joined.desk.id.startsWith("desk-"));
  const saved = JSON.parse(readFileSync(join(cfgDir, `${office.id}.json`), "utf8"));
  assert.equal(saved.agentToken, joined.agentToken);

  assert.match(run("status", "working", "fixing", "tests"), /working: fixing tests/);
  assert.match(run("say", "hello", "from", "cli"), /said/);
  assert.match(run("chat", "send", "room", "message"), /to the room/);
  assert.match(run("chat", "read", "--since", "0"), /cli-bot: hello from cli/);
  assert.match(run("look"), /cli-bot \[.*\] working: fixing tests/);
  assert.match(run("kinds"), /desk\s+2x2 object/);
  const added = runJson("add", "plant", "22", "11");
  const id = added.item.id;
  assert.match(run("move", id, "21", "11"), /x21 z11/);
  assert.match(run("rotate", id, "90"), /rot 90/);
  assert.match(run("rm", id), new RegExp(`removed ${id}`));
  const sign = runJson("look").items.find((s) => s.includes(" sign ")).split(" ")[0];
  assert.match(run("text", sign, "cli", "was", "here"), /"cli was here"/);
  assert.match(runFail("add", "plant", "99", "1").stderr, /out of bounds/);

  // ---- design: theme, custom kinds, upload, logo, designer ----
  assert.match(run("theme"), /floor\s+wood #d9b086/);
  const branded = runJson("theme", "set", "--brand", "#e94d3d,#141414,#d28f88");
  assert.deepEqual(branded.theme.accents, ["#e94d3d", "#d28f88", "#141414"]);
  assert.match(run("theme", "set", '{"lighting":"cool","floor":{"material":"tile"}}'), /floor\s+tile .*\n[\s\S]*light\s+cool/);
  assert.match(runFail("theme", "set", '{"lighting":"disco"}').stderr, /lighting/);

  const kindFile = join(cfgDir, "arcade.json");
  writeFileSync(kindFile, JSON.stringify({
    kind: "arcade-cabinet",
    label: "Arcade cabinet",
    footprint: { w: 1, d: 1 },
    boxes: [
      { x: 2, y: 0, z: 2, w: 12, h: 40, d: 12, color: "#141414" },
      { x: 3, y: 24, z: 13, w: 10, h: 10, d: 1, color: "#222222", material: "screen", emissive: true },
      { x: 3, y: 18, z: 10, w: 10, h: 2, d: 5, color: "#e94d3d" },
    ],
    stations: [{ x: 8, z: 24, rot: 180, activity: "play" }],
    screen: true,
  }));
  assert.match(run("define-kind", kindFile), /defined arcade-cabinet \(1x1, 3 boxes\)/);
  assert.match(run("kinds"), /custom:\n\s+arcade-cabinet\s+1x1 object 3 boxes screen/);
  const cab = runJson("add", "arcade-cabinet", "22", "11").item.id;
  assert.match(run("look"), /stations \(.*play 1/);
  assert.match(runFail("delete-kind", "arcade-cabinet").stderr, /in use by arcade-cabinet-1/);
  assert.match(run("define-kind", kindFile), /redefined arcade-cabinet[\s\S]*updated arcade-cabinet-1/);
  assert.match(run("rm", cab), /removed/);
  assert.match(run("delete-kind", "arcade-cabinet"), /deleted arcade-cabinet/);

  const logoFile = join(cfgDir, "logo.png");
  writeFileSync(logoFile, makePng(64, 64, (x, y) => (Math.hypot(x - 32, y - 32) < 26 ? [0xe9, 0x4d, 0x3d, 255] : [0x14, 0x14, 0x14, 255])));
  const up = runJson("upload", logoFile);
  assert.match(up.assetId, /^a[0-9a-f]{23}$/);
  assert.equal(up.w, 64);
  const served = await fetch(up.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.match(served.headers.get("cache-control"), /max-age=86400/);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), readFileSync(logoFile));
  assert.match(run("set-logo", up.assetId, "--on-signs"), new RegExp(`logo is ${up.assetId} \\(also on signs\\)`));
  assert.match(run("theme"), new RegExp(`image ${up.assetId} 64x64 image/png logo.png`));
  const gif = join(cfgDir, "x.gif");
  writeFileSync(gif, "GIF89a");
  assert.match(runFail("upload", gif).stderr, /\.png, \.jpg or \.webp/);
  const fake = join(cfgDir, "fake.png");
  writeFileSync(fake, "<svg xmlns='http://www.w3.org/2000/svg'/>");
  assert.match(runFail("upload", fake).stderr, /magic bytes/);
  assert.match(run("designer", url, "--key", office.ownerKey, "cli-bot"), /is the office designer/);
  assert.match(run("look"), /cli-bot \[.*\(designer\)/);

  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/o/${office.id}/ws?k=${encodeURIComponent(office.viewKey)}`);
  const snap = await new Promise((res, rej) => {
    ws.onmessage = (e) => res(JSON.parse(e.data));
    ws.onerror = rej;
  });
  assert.equal(snap.type, "snapshot");
  assert.equal(snap.state.agents[0].name, "cli-bot");
  assert.equal(snap.state.theme.logo, up.assetId);
  assert.equal(snap.state.designer, snap.state.agents[0].id);
  assert.equal(snap.state.assets[0].url, `/o/${office.id}/assets/${up.assetId}`);
  ws.close();

  if (existsSync(join(root, "public", "index.html"))) {
    const view = await fetch(`${url}/o/${office.id}?k=${encodeURIComponent(office.viewKey)}`);
    assert.equal(view.status, 200);
    assert.match(view.headers.get("content-type") ?? "", /text\/html/);
  } else console.log("cli e2e: public/index.html not built yet, skipping the viewer page check");

  const mcp = new Client({ name: "e2e", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${office.mcpUrl}?mode=design`), { requestInit: { headers: { authorization: `Bearer ${office.joinKey}` } } }));
  const mcpJoin = await mcp.callTool({ name: "office_join", arguments: { name: "mcp-bot", client: "e2e" } });
  assert.ok(!mcpJoin.isError, mcpJoin.content[0].text);
  const { prompts } = await mcp.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), ["office-designer"]);
  const mcpLook = JSON.parse((await mcp.callTool({ name: "office_look", arguments: {} })).content[0].text);
  assert.ok(mcpLook.design.seats > 0 && mcpLook.stations.length > 0);
  assert.equal(mcpLook.you.name, "mcp-bot");
  assert.deepEqual(mcpLook.agents.map((a) => a.name).sort(), ["cli-bot", "mcp-bot"]);
  await mcp.callTool({ name: "office_leave", arguments: {} });
  await mcp.close();

  assert.match(run("leave"), /left/);
  assert.match(runFail("look").stderr, /office_join|agentToken/);
  console.log("cli e2e: all checks passed");
} finally {
  dev?.kill("SIGTERM");
  rmSync(cfgDir, { recursive: true, force: true });
}
