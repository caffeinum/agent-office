// Shared setup for the City DO tests: the singleton stub, a controllable clock, linked offices, the public feed.
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { blockToLonLat } from "../public/shared/city.js";
import manifest from "../public/city/fixture/manifest.json";
import type { City } from "../src/city/do";
import { ADMIN, call, createOffice, join, ORIGIN, type Created } from "./helpers";
import { navForTests } from "./city-nav";

export const cityStub = () => env.CITY.get(env.CITY.idFromName("sf"));
export const officeStub = (o: Created) => env.OFFICE.get(env.OFFICE.idFromName(o.id));

/** The City's clock in these tests: frozen unless a test moves it. */
export const clock = { now: Date.now() };

export async function withCity<T>(fn: (c: City, state: DurableObjectState) => T | Promise<T>): Promise<T> {
  return runInDurableObject(cityStub(), (c: City, state: DurableObjectState) => fn(c, state));
}

/** Fresh nav seam and a frozen clock at least `ahead` ms past the last test's (deadlines only move forward). */
export async function setupCity(ahead = 60_000): Promise<void> {
  clock.now = Math.max(Date.now(), clock.now + ahead);
  await withCity((c) => {
    c.nav = navForTests();
    c.clock = () => clock.now;
  });
}

export async function advance(ms: number): Promise<void> {
  clock.now += ms;
  await setupCity(0);
}

export async function runCityAlarm(): Promise<boolean> {
  return runDurableObjectAlarm(cityStub());
}

export async function admin(path: string, method = "GET") {
  const res = await SELF.fetch(`${ORIGIN}/api/city/sf/links${path}`, { method, headers: { authorization: `Bearer ${ADMIN}` } });
  return { status: res.status, body: (await res.json()) as any };
}

let ipSeq = 0;
export async function requestLink(o: Created, siteId: string, ip = `10.0.${Math.floor(++ipSeq / 200)}.${ipSeq % 200}`) {
  const res = await SELF.fetch(`${ORIGIN}/api/o/${o.id}/city`, {
    method: "PUT",
    headers: { authorization: `Bearer ${o.ownerKey}`, "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ city: "sf", siteId }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** An office linked (approved) to `siteId`, with the office's pushes settled. */
export async function linkedOffice(siteId: string, name = "City Office"): Promise<Created> {
  const o = await createOffice(name);
  const r = await requestLink(o, siteId);
  if (r.status !== 200) throw new Error(`link request: ${r.status} ${JSON.stringify(r.body)}`);
  const a = await admin(`/${o.id}/approve`, "POST");
  if (a.status !== 200) throw new Error(`approve: ${a.status} ${JSON.stringify(a.body)}`);
  return o;
}

/** An agent joined with the owner key (may walk without an invite flag). */
export async function ownerAgent(o: Created, name: string, extra: Record<string, unknown> = {}) {
  const r = await call(o, "join", { name, ...extra }, { key: o.ownerKey });
  if (r.status !== 200) throw new Error(`join ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as Awaited<ReturnType<typeof join>>;
}

export async function city(o: Created, token: string, args: Record<string, unknown>, key = o.ownerKey) {
  return call(o, "city", args, { token, key });
}

/** Runs the office's alarm now: any debounced city push goes out. */
export async function flushOffice(o: Created): Promise<void> {
  await runDurableObjectAlarm(officeStub(o));
}

export async function publicCity(): Promise<any> {
  const res = await SELF.fetch(`${ORIGIN}/api/city/sf`);
  if (res.status !== 200) throw new Error(`GET /api/city/sf: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function openCityWs() {
  const res = await SELF.fetch(`${ORIGIN}/city/sf/ws`, { headers: { upgrade: "websocket" } });
  if (res.status !== 101) throw new Error(`city ws: ${res.status} ${await res.text()}`);
  const ws = res.webSocket!;
  const frames: any[] = [];
  ws.addEventListener("message", (e) => {
    frames.push(JSON.parse(e.data as string));
  });
  ws.accept();
  const next = async (pred: (f: any) => boolean, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      const hit = frames.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    throw new Error(`no city frame matching; got ${JSON.stringify(frames.map((f) => f.type))}`);
  };
  return { ws, frames, next };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(f: () => Promise<T | null | undefined | false>, what: string, tries = 80): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = await f();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** lat/lon of a fixture block point, for {lat, lon} go targets. */
export function latLonOf(x: number, z: number): { lat: number; lon: number } {
  const { lat, lon } = blockToLonLat(x, z, manifest.proj);
  return { lat, lon };
}

/** Every key and string value anywhere in a JSON value. */
export function deepStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) deepStrings(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
    out.push(k);
    deepStrings(x, out);
  }
  return out;
}

export function walkerNamed(snapshot: { walkers: any[] }, name: string) {
  return snapshot.walkers.find((w) => w.name === name);
}
