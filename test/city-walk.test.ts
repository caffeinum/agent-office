import { beforeEach, describe, expect, it } from "vitest";
import { call } from "./helpers";
import {
  advance, city, clock, cityStub, flushOffice, latLonOf, linkedOffice, openCityWs, ownerAgent, publicCity, runCityAlarm, setupCity, sleep, until, walkerNamed, withCity,
} from "./city-harness";
import { CITY_AWAY_MS, CITY_REMOVE_MS } from "../src/city/walkers";

beforeEach(() => setupCity());

/** Distance from (x, z) to the polyline, and the y interpolated at the closest point. */
function onPath(path: number[][], x: number, z: number): { dist: number; y: number } {
  let best = { dist: Infinity, y: NaN };
  for (let i = 1; i < path.length; i++) {
    const [ax, az, ay] = path[i - 1]!;
    const [bx, bz, by] = path[i]!;
    const dx = bx! - ax!, dz = bz! - az!;
    const l2 = dx * dx + dz * dz;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax!) * dx + (z - az!) * dz) / l2));
    const d = Math.hypot(ax! + dx * t - x, az! + dz * t - z);
    if (d < best.dist) best = { dist: d, y: ay! + (by! - ay!) * t };
  }
  return best;
}

const lenOf = (path: number[][]) => path.slice(1).reduce((n, p, i) => n + Math.hypot(p[0]! - path[i]![0]!, p[1]! - path[i]![1]!), 0);

describe("office_city movement", () => {
  it("go to an intersection from the company door walks at 2 blocks/s; mid-way the walker is on the path with graph y", async () => {
    const o = await linkedOffice("fixture-labs", "Labs");
    const ada = await ownerAgent(o, "Ada Walk");
    const t0 = clock.now;
    const go = await city(o, ada.agentToken, { op: "go", to: "Fixture Ave & Test St" });
    expect(go.status).toBe(200);
    expect(go.body.mode).toBe("walk");
    expect(go.body.to.name).toBe("Fixture Ave & Test St");
    expect(go.body.via).toContain("Fixture Ave");
    expect(go.body.viewUrl).toMatch(/^\/city\/sf\?follow=w[0-9a-f]{16}$/);
    const w = walkerNamed(await publicCity(), "Ada Walk");
    expect(w.path[0]).toEqual([3697.5, 1668.5, 1]); // the Fixture Labs door node
    const length = lenOf(w.path);
    expect(Math.abs(go.body.etaSec - length / 2)).toBeLessThanOrEqual(1);
    expect(go.body.distanceM).toBe(Math.round(length * 3));

    await advance(t0 + (go.body.etaSec * 1000) / 2 - clock.now);
    const look = await city(o, ada.agentToken, { op: "look" });
    expect(look.status).toBe(200);
    expect(look.body.you.moving).toBe(true);
    const at = onPath(w.path, look.body.you.x, look.body.you.z);
    expect(at.dist).toBeLessThan(0.1);
    expect(Math.abs(look.body.you.y - at.y)).toBeLessThan(0.1);
    expect(look.body.you.etaSec).toBeCloseTo(go.body.etaSec / 2, 0);
  });

  it("a trip over 300 blocks rides at 8 blocks/s, and y on the bridge deck comes from the graph", async () => {
    const o = await linkedOffice("fixture-labs", "Labs Rider");
    const rio = await ownerAgent(o, "Rio Ride");
    const toPark = await city(o, rio.agentToken, { op: "go", to: "Fixture Park" });
    expect(toPark.status).toBe(200);
    expect(toPark.body.mode).toBe("walk");
    await advance(toPark.body.etaSec * 1000 + 3000);
    await runCityAlarm();
    const far = await city(o, rio.agentToken, { op: "go", to: latLonOf(3780.5, 1576.5) }); // the far end of the fixture bridge
    expect(far.status).toBe(200);
    expect(far.body.mode).toBe("ride");
    const w = walkerNamed(await publicCity(), "Rio Ride");
    const length = lenOf(w.path);
    expect(length).toBeGreaterThan(300);
    expect(w.speed).toBe(8);
    expect(Math.abs(far.body.etaSec - length / 8)).toBeLessThanOrEqual(1);
    // when the rider is over the deck (z 1601.5 on the bridge), y is the deck top (4), not the water below
    const t0 = w.t0;
    let along = 0;
    for (let i = 1; i < w.path.length; i++) {
      const [a, b] = [w.path[i - 1], w.path[i]];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (b[1] <= 1601.5 && a[1] > 1601.5) {
        along += seg * ((a[1] - 1601.5) / (a[1] - b[1]));
        break;
      }
      along += seg;
    }
    await advance(t0 + (along / 8) * 1000 - clock.now);
    const look = await city(o, rio.agentToken, { op: "look" });
    expect(look.body.you.z).toBeCloseTo(1601.5, 0);
    expect(look.body.you.y).toBeCloseTo(4, 1);
  });

  it("the alarm emits arrive and re-arms to the next deadline: two staggered walkers arrive in order", async () => {
    const o = await linkedOffice("example-robotics", "Robots");
    const ws = await openCityWs();
    await ws.next((f) => f.type === "snapshot");
    const far = await ownerAgent(o, "Far Goer");
    const near = await ownerAgent(o, "Near Goer");
    const a = await city(o, far.agentToken, { op: "go", to: "Fixture Ferry" });
    const b = await city(o, near.agentToken, { op: "go", to: "Fixture Ave & Test St" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.etaSec).toBeGreaterThan(b.body.etaSec + 10);
    const pub = await publicCity();
    const [wa, wb] = [walkerNamed(pub, "Far Goer"), walkerNamed(pub, "Near Goer")];
    const arriveA = wa.t0 + (lenOf(wa.path) / wa.speed) * 1000;
    const arriveB = wb.t0 + (lenOf(wb.path) / wb.speed) * 1000;
    const alarm1 = await withCity((_c, state) => state.storage.getAlarm());
    expect(alarm1).not.toBeNull();
    expect(alarm1!).toBeLessThanOrEqual(arriveB);

    await advance(arriveB + 10 - clock.now);
    expect(await runCityAlarm()).toBe(true);
    const arrivedB = await ws.next((f) => f.type === "arrive" && f.walker.id === wb.id);
    expect(arrivedB.walker.path).toHaveLength(1);
    expect(ws.frames.some((f) => f.type === "arrive" && f.walker.id === wa.id)).toBe(false);
    const alarm2 = await withCity((_c, state) => state.storage.getAlarm());
    expect(alarm2!).toBeGreaterThan(clock.now);
    expect(alarm2!).toBeLessThanOrEqual(arriveA);

    await advance(arriveA + 10 - clock.now);
    // run the alarm until A's arrival is due (earlier deadlines, e.g. a flush, come first)
    for (let i = 0; i < 5 && !ws.frames.some((f) => f.type === "arrive" && f.walker.id === wa.id); i++) {
      await runCityAlarm();
      await sleep(20);
    }
    await ws.next((f) => f.type === "arrive" && f.walker.id === wa.id);
    const order = ws.frames.filter((f) => f.type === "arrive" && (f.walker.id === wa.id || f.walker.id === wb.id)).map((f) => f.walker.id);
    expect(order).toEqual([wb.id, wa.id]);
    ws.ws.close();
  });

  it("refuses unknown places with candidates, and a second go within 2 s is 429", async () => {
    const o = await linkedOffice("fixture-labs", "Labs Limits");
    const ann = await ownerAgent(o, "Ann Limit");
    const unknown = await city(o, ann.agentToken, { op: "go", to: "Fixture" });
    expect(unknown.status).toBe(400);
    expect(Array.isArray(unknown.body.candidates)).toBe(true);
    await advance(2500);
    expect((await city(o, ann.agentToken, { op: "go", to: "Fixture Ferry" })).status).toBe(200);
    const again = await city(o, ann.agentToken, { op: "go", to: "Fixture Park" });
    expect(again.status).toBe(429);
    expect(again.body.retryAfter).toBeGreaterThan(0);
    await advance(2100);
    expect((await city(o, ann.agentToken, { op: "go", to: "Fixture Park" })).status).toBe(200);
    await advance(2100);
    const nowhere = await city(o, ann.agentToken, { op: "go", to: latLonOf(0, 0) });
    expect(nowhere.status).toBe(400);
    expect(nowhere.body.error).toMatch(/no walkable street within 64 blocks/);
  });

  it("go inside hides the walker at its own door and counts it inside; outside brings it back", async () => {
    const o = await linkedOffice("example-robotics", "Robots Inside");
    const ivy = await ownerAgent(o, "Ivy Inside");
    expect((await city(o, ivy.agentToken, { op: "look" })).status).toBe(200);
    await advance(2100);
    const inside = await city(o, ivy.agentToken, { op: "go", to: "inside" });
    expect(inside.status).toBe(200);
    const pub = await publicCity();
    expect(walkerNamed(pub, "Ivy Inside")).toBeFalsy();
    expect(pub.sites.find((s: any) => s.siteId === "example-robotics").inside).toBeGreaterThanOrEqual(1);
    await advance(2100);
    expect((await city(o, ivy.agentToken, { op: "go", to: "outside" })).status).toBe(200);
    expect(walkerNamed(await publicCity(), "Ivy Inside")).toBeTruthy();
    await advance(2100);
    expect((await city(o, ivy.agentToken, { op: "go", to: "Fixture Park" })).status).toBe(200);
    await advance(2100);
    expect((await city(o, ivy.agentToken, { op: "go", to: "inside" })).status).toBe(400);
  });
});

describe("walker lifecycle", () => {
  it("5 min without calls shows away, 1 h removes it with left; office_leave removes at once", async () => {
    const o = await linkedOffice("fixture-labs", "Labs Life");
    const ws = await openCityWs();
    const sid = await ownerAgent(o, "Sid Idle");
    const lea = await ownerAgent(o, "Lea Leave");
    expect((await city(o, sid.agentToken, { op: "look" })).status).toBe(200);
    expect((await city(o, lea.agentToken, { op: "look" })).status).toBe(200);
    await flushOffice(o);
    const id = walkerNamed(await publicCity(), "Sid Idle").id;

    expect((await call(o, "leave", {}, { token: lea.agentToken, key: o.ownerKey })).status).toBe(200);
    expect(walkerNamed(await publicCity(), "Lea Leave")).toBeFalsy();

    await advance(CITY_AWAY_MS + 1000);
    await runCityAlarm();
    expect(walkerNamed(await publicCity(), "Sid Idle").status).toBe("away");
    await advance(CITY_REMOVE_MS);
    await runCityAlarm();
    expect(walkerNamed(await publicCity(), "Sid Idle")).toBeFalsy();
    await ws.next((f) => f.type === "left" && f.id === id);
    ws.ws.close();
  });

  it("walkers, links and the chat ring survive a forced eviction", async () => {
    const o = await linkedOffice("example-robotics", "Robots Evict");
    const eve = await ownerAgent(o, "Eve Evict");
    expect((await city(o, eve.agentToken, { op: "go", to: "Fixture Ferry" })).status).toBe(200);
    expect((await city(o, eve.agentToken, { op: "chat", chat: "send", text: "before the eviction" })).status).toBe(200);
    const before = walkerNamed(await publicCity(), "Eve Evict");
    await withCity((_c, state) => {
      try {
        state.abort("test eviction");
      } catch {
        // abort throws in the aborted context
      }
    }).catch(() => undefined);
    await setupCity(0);
    const fresh = await withCity((c) => ({ walkers: (c as any).walkers.size as number, links: (c as any).links.size as number, graph: (c as any).graph }));
    expect(fresh.walkers).toBeGreaterThan(0);
    expect(fresh.links).toBeGreaterThan(0);
    expect(fresh.graph).toBeNull(); // a new instance: nothing came from memory
    const after = walkerNamed(await publicCity(), "Eve Evict");
    expect(after).toEqual({ ...before, status: after.status });
    const links = await cityStub().listLinks("approved");
    expect(links.map((l) => l.officeId)).toContain(o.id);
    const ws = await openCityWs();
    const snap = await ws.next((f) => f.type === "snapshot");
    expect(snap.chatTail.map((m: any) => m.text)).toContain("before the eviction");
    ws.ws.close();
    await advance(2100);
    const read = await city(o, eve.agentToken, { op: "chat", chat: "read" });
    expect(read.status).toBe(200);
  });

  it("a builtAt change seen by the 60 s check re-snaps walkers and cancels paths with arrive", async () => {
    const o = await linkedOffice("fixture-labs", "Labs Resnap");
    const rex = await ownerAgent(o, "Rex Resnap");
    expect((await city(o, rex.agentToken, { op: "go", to: "Fixture Ferry" })).status).toBe(200);
    expect(walkerNamed(await publicCity(), "Rex Resnap").speed).toBe(2);
    const ws = await openCityWs();
    await ws.next((f) => f.type === "snapshot");
    await withCity((c) => {
      (c as any).graph.builtAt = "2026-01-01T00:00:00Z";
      (c as any).graphCheckedAt = 0;
    });
    await advance(1100);
    const w = walkerNamed(await publicCity(), "Rex Resnap");
    expect(w.speed).toBe(0);
    expect(w.path).toEqual([[3756.5, 1628.5, 1]]); // the Fixture Ferry node: snapped to its `at`
    await ws.next((f) => f.type === "arrive" && f.walker.id === w.id);
    ws.ws.close();
  });
});

describe("names", () => {
  it("a duplicate name gets a number; a name that reads as another company is refused", async () => {
    const o1 = await linkedOffice("fixture-labs", "Labs Names");
    const o2 = await linkedOffice("example-robotics", "Robots Names");
    const b1 = await ownerAgent(o1, "Bob Dup");
    const b2 = await ownerAgent(o2, "Bob Dup");
    expect((await city(o1, b1.agentToken, { op: "look" })).status).toBe(200);
    const second = await city(o2, b2.agentToken, { op: "look" });
    expect(second.status).toBe(200);
    expect(second.body.you.name).toBe("Bob Dup 2");

    const fake = await ownerAgent(o1, "example robotics");
    const refused = await city(o1, fake.agentToken, { op: "look" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("name looks like Example Robotics; pick another");
    const own = await ownerAgent(o1, "Fixture Labs");
    expect((await city(o1, own.agentToken, { op: "look" })).status).toBe(200);
  });
});

describe("city chat", () => {
  it("near reaches 33 blocks but not 73; city scope is limited; DMs never reach viewers", async () => {
    const o = await linkedOffice("fixture-labs", "Labs Chat");
    const s = await ownerAgent(o, "Sam Speaker");
    const n = await ownerAgent(o, "Nia Near");
    const f = await ownerAgent(o, "Fay Far");
    expect((await city(o, s.agentToken, { op: "look" })).status).toBe(200);
    expect((await city(o, n.agentToken, { op: "go", to: latLonOf(3664.5, 1665.5) })).status).toBe(200);
    expect((await city(o, f.agentToken, { op: "go", to: latLonOf(3624.5, 1665.5) })).status).toBe(200);
    await advance(60_000);
    await runCityAlarm();
    const ws = await openCityWs();
    await ws.next((fr) => fr.type === "snapshot");

    const sent = await city(o, s.agentToken, { op: "chat", chat: "send", text: "hello near" });
    expect(sent.status).toBe(200);
    const readN = await city(o, n.agentToken, { op: "chat", chat: "read" });
    expect(readN.body.messages.map((m: any) => m.text)).toContain("hello near");
    const readF = await city(o, f.agentToken, { op: "chat", chat: "read" });
    expect(readF.body.messages.map((m: any) => m.text)).not.toContain("hello near");
    const nearFrame = await ws.next((fr) => fr.type === "chat" && fr.msg.text === "hello near");
    expect(nearFrame.msg.scope).toBe("near");

    expect((await city(o, s.agentToken, { op: "chat", chat: "send", scope: "city", text: "hello city" })).status).toBe(200);
    const limited = await city(o, s.agentToken, { op: "chat", chat: "send", scope: "city", text: "hello again" });
    expect(limited.status).toBe(429);
    const readFar = await city(o, f.agentToken, { op: "chat", chat: "read" });
    expect(readFar.body.messages.map((m: any) => m.text)).toContain("hello city");

    expect((await city(o, s.agentToken, { op: "chat", chat: "send", to: "Fay Far", text: "secret dm" })).status).toBe(200);
    const dm = await city(o, f.agentToken, { op: "chat", chat: "read" });
    expect(dm.body.messages.find((m: any) => m.text === "secret dm").scope).toBe("dm");
    await city(o, s.agentToken, { op: "chat", chat: "say", text: "after the dm" });
    await ws.next((fr) => fr.type === "say" && fr.text === "after the dm");
    expect(JSON.stringify(ws.frames)).not.toContain("secret dm");
    const late = await openCityWs();
    const snap = await late.next((fr) => fr.type === "snapshot");
    expect(JSON.stringify(snap)).not.toContain("secret dm");
    expect(snap.chatTail.map((m: any) => m.text)).toContain("hello city");
    expect(JSON.stringify(await publicCity())).not.toContain("secret dm");
    ws.ws.close();
    late.ws.close();
  });

  it("chat wait returns when a near message arrives", async () => {
    const o = await linkedOffice("example-robotics", "Robots Wait");
    const a = await ownerAgent(o, "Wai Waiter");
    const b = await ownerAgent(o, "Tal Talker");
    await city(o, a.agentToken, { op: "chat", chat: "read" });
    await city(o, b.agentToken, { op: "look" });
    const waiting = city(o, a.agentToken, { op: "chat", chat: "wait", timeoutSec: 5 });
    await sleep(100);
    await city(o, b.agentToken, { op: "chat", chat: "send", text: "wake up" });
    const got = await waiting;
    expect(got.status).toBe(200);
    expect(got.body.messages.map((m: any) => m.text)).toContain("wake up");
  });
});

describe("bridge", () => {
  it("an office agent with a live walker is bridged with out:true and the office shows it in the city", async () => {
    const o = await linkedOffice("example-robotics", "Robots Out");
    const ola = await ownerAgent(o, "Ola Out");
    await ownerAgent(o, "Desk Dweller");
    expect((await city(o, ola.agentToken, { op: "look" })).status).toBe(200);
    await flushOffice(o);
    const agents = await until(async () => {
      const rows = await withCity((c) => (c as any).ctx.storage.sql.exec("SELECT agents FROM presence WHERE officeId = ?", o.id).toArray());
      const list = rows[0] ? (JSON.parse(rows[0].agents) as any[]) : [];
      return list.find((a) => a.name === "Ola Out")?.out ? list : null;
    }, "out:true for Ola");
    expect(agents.find((a) => a.name === "Desk Dweller").out).toBe(false);
    const site = (await publicCity()).sites.find((s: any) => s.siteId === "example-robotics");
    expect(site.agents.map((a: any) => a.name)).toContain("Desk Dweller");
    expect(site.agents.map((a: any) => a.name)).not.toContain("Ola Out");
    const look = await call(o, "look", {}, { token: ola.agentToken, key: o.ownerKey });
    expect(look.body.you.inCity).toBe(true);
    expect(look.body.city).toEqual({ siteId: "example-robotics", state: "approved" });
  });

  it("50 presence pushes within 1 s give at most 1 presence frame per socket", async () => {
    const o = await linkedOffice("fixture-labs", "Labs Burst");
    // a running clock (kept ahead of the frozen one so deadlines never move backwards)
    const ahead = clock.now - Date.now();
    await withCity((c) => {
      c.clock = () => Date.now() + ahead;
    });
    await sleep(1100);
    const ws = await openCityWs();
    await ws.next((f) => f.type === "snapshot");
    const t = Date.now();
    for (let i = 0; i < 50; i++) await cityStub().officePresence(o.id, [{ agentId: "burst", name: `Burst ${i}`, hue: i, status: "working", out: false }]);
    expect(Date.now() - t).toBeLessThan(1000);
    const within = ws.frames.filter((f) => f.type === "presence" && f.site.siteId === "fixture-labs").length;
    expect(within).toBeLessThanOrEqual(1);
    await sleep(1300);
    await runCityAlarm();
    const frames = ws.frames.filter((f) => f.type === "presence" && f.site.siteId === "fixture-labs");
    expect(frames.length).toBeLessThanOrEqual(2);
    expect(frames.at(-1).site.agents.map((a: any) => a.name)).toContain("Burst 49");
    ws.ws.close();
  });
});
