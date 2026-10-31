// End-to-end: boots `wrangler dev`, then drives the real CLI (bin/agent-office) against it.
// Usage: node test/cli-e2e.mjs [--url http://127.0.0.1:8799]  (without --url it starts wrangler dev itself)
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/o/${office.id}/ws?k=${encodeURIComponent(office.viewKey)}`);
  const snap = await new Promise((res, rej) => {
    ws.onmessage = (e) => res(JSON.parse(e.data));
    ws.onerror = rej;
  });
  assert.equal(snap.type, "snapshot");
  assert.equal(snap.state.agents[0].name, "cli-bot");
  ws.close();

  if (existsSync(join(root, "public", "index.html"))) {
    const view = await fetch(`${url}/o/${office.id}?k=${encodeURIComponent(office.viewKey)}`);
    assert.equal(view.status, 200);
    assert.match(view.headers.get("content-type") ?? "", /text\/html/);
  } else console.log("cli e2e: public/index.html not built yet, skipping the viewer page check");

  const mcp = new Client({ name: "e2e", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(office.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${office.joinKey}` } } }));
  const mcpJoin = await mcp.callTool({ name: "office_join", arguments: { name: "mcp-bot", client: "e2e" } });
  assert.ok(!mcpJoin.isError, mcpJoin.content[0].text);
  const mcpLook = JSON.parse((await mcp.callTool({ name: "office_look", arguments: {} })).content[0].text);
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
