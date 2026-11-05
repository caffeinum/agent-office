// usage: node check.mjs <office.json> agent <name> [status]
//        node check.mjs <office.json> chat <name> <substring>
//        node check.mjs <office.json> items <kind> <min count>
import { readFileSync } from "node:fs";

const [file, what, ...args] = process.argv.slice(2);
const office = JSON.parse(readFileSync(file, "utf8"));
const auth = { Authorization: `Bearer ${office.joinKey}`, "content-type": "application/json" };

async function call(tool, body, token) {
  const res = await fetch(`${office.apiUrl}/${tool}`, {
    method: "POST",
    headers: token ? { ...auth, "X-Agent-Token": token } : auth,
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${tool} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const look = await call("look");

if (what === "agent") {
  const [name, status] = args;
  const agent = look.agents.find((a) => a.name === name);
  if (!agent) fail(`no agent named ${name}; agents: ${look.agents.map((a) => a.name).join(", ")}`);
  if (status && agent.status !== status) fail(`${name} is ${agent.status}, want ${status}`);
} else if (what === "chat") {
  const [name, needle] = args;
  const { agentToken } = await call("join", { name: `checker-${process.pid}` });
  const read = await call("chat_read", {}, agentToken);
  const messages = read.messages ?? read;
  const hit = JSON.stringify(messages).toLowerCase();
  await call("leave", {}, agentToken).catch(() => {});
  if (!hit.includes(name.toLowerCase()) || !hit.includes(needle.toLowerCase()))
    fail(`no chat from ${name} containing "${needle}": ${JSON.stringify(messages).slice(0, 800)}`);
} else if (what === "items") {
  const [kind, min] = args;
  const count = look.items.filter((i) => i.split(" ")[1] === kind).length;
  if (count < Number(min)) fail(`${count} ${kind}(s), want at least ${min}`);
} else {
  fail(`unknown check ${what}`);
}
