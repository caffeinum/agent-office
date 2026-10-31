import { describe, expect, it } from "vitest";
import { call, createOffice, join } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("office_chat wait", () => {
  it("returns unread messages right away, like read, and advances lastRead", async () => {
    const o = await createOffice();
    const a = await join(o, "Ada");
    const b = await join(o, "Bo");
    await call(o, "chat_send", { to: "Ada", text: "already here" }, { token: b.agentToken });
    const t0 = Date.now();
    const got = await call(o, "chat", { op: "wait", timeoutSec: 5 }, { token: a.agentToken });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(got.body.messages.map((m: { text: string }) => m.text)).toEqual(["already here"]);
    expect((await call(o, "chat_read", {}, { token: a.agentToken })).body.messages).toEqual([]);
  });

  it("wakes on a DM to it", async () => {
    const o = await createOffice();
    const a = await join(o, "Ada");
    const b = await join(o, "Bo");
    const waiting = call(o, "chat_wait", { timeoutSec: 10 }, { token: a.agentToken });
    await sleep(150);
    await call(o, "chat_send", { to: "Bo", text: "not for ada" }, { token: a.agentToken });
    await call(o, "chat_send", { to: "Ada", text: "ping" }, { token: b.agentToken });
    const got = await waiting;
    expect(got.status).toBe(200);
    expect(got.body.timedOut).toBeUndefined();
    expect(got.body.messages.map((m: { text: string }) => m.text)).toEqual(["not for ada", "ping"]);
  });

  it("wakes on a room message (from a human too)", async () => {
    const o = await createOffice();
    const a = await join(o, "Ada");
    const b = await join(o, "Bo");
    const waiting = call(o, "chat", { op: "wait" }, { token: a.agentToken });
    await sleep(150);
    await call(o, "chat_send", { text: "hello room" }, { token: b.agentToken });
    expect((await waiting).body.messages.map((m: { text: string }) => m.text)).toEqual(["hello room"]);
  });

  it("times out with {messages: [], timedOut: true}", async () => {
    const o = await createOffice();
    const a = await join(o, "Ada");
    const t0 = Date.now();
    const got = await call(o, "chat_wait", { timeoutSec: 1 }, { token: a.agentToken });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(got.body).toMatchObject({ messages: [], timedOut: true });
    expect((await call(o, "chat_wait", { timeoutSec: 51 }, { token: a.agentToken })).status).toBe(400);
  });

  it("a second wait replaces the first, which returns early", async () => {
    const o = await createOffice();
    const a = await join(o, "Ada");
    const b = await join(o, "Bo");
    const first = call(o, "chat_wait", { timeoutSec: 20 }, { token: a.agentToken });
    await sleep(150);
    const second = call(o, "chat_wait", { timeoutSec: 20 }, { token: a.agentToken });
    const early = await first;
    expect(early.body).toMatchObject({ messages: [], timedOut: false, replaced: true });
    await call(o, "chat_send", { to: "Ada", text: "for the second" }, { token: b.agentToken });
    expect((await second).body.messages.map((m: { text: string }) => m.text)).toEqual(["for the second"]);
  });

  it("ends with 401 when the agent is shown out while waiting", async () => {
    const o = await createOffice();
    const a = await join(o, "Ada");
    const waiting = call(o, "chat_wait", { timeoutSec: 20 }, { token: a.agentToken });
    await sleep(150);
    await call(o, "kick", { id: a.agent.id }, { key: o.ownerKey });
    expect((await waiting).status).toBe(401);
  });
});
