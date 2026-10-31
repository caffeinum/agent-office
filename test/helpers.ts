import { env, SELF } from "cloudflare:test";

export const ORIGIN = "https://office.test";
export const ADMIN: string = env.ADMIN_KEY;

export interface Created {
  id: string;
  name: string;
  ownerKey: string;
  joinKey: string;
  viewKey: string;
  mcpUrl: string;
  apiUrl: string;
  viewUrl: string;
}

export async function createOffice(name = "Test Office"): Promise<Created> {
  const res = await SELF.fetch(`${ORIGIN}/api/offices`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status !== 201) throw new Error(`createOffice: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function call(
  office: Created,
  tool: string,
  args: Record<string, unknown> = {},
  opts: { token?: string; key?: string; method?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? office.joinKey}`, "content-type": "application/json" };
  if (opts.token) headers["x-agent-token"] = opts.token;
  const method = opts.method ?? "POST";
  const res = await SELF.fetch(`${ORIGIN}/api/o/${office.id}/${tool}`, { method, headers, body: method === "GET" ? undefined : JSON.stringify(args) });
  return { status: res.status, body: await res.json() };
}

export async function join(office: Created, name: string, extra: Record<string, unknown> = {}) {
  const r = await call(office, "join", { name, ...extra });
  if (r.status !== 200) throw new Error(`join: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { agentToken: string; agent: { id: string; deskId?: string; name: string }; desk: { id: string } | null };
}
