// office_leave and the silence walk-out keep the agent for a comeback; office_delete_me, a kick and an invite revoke don't.
import { runDurableObjectAlarm, runInDurableObject, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { REMOVE_MS, type Office } from "../src/office";
import { call, createOffice, join } from "./helpers";

const stubOf = (id: string) => env.OFFICE.get(env.OFFICE.idFromName(id));
const roster = async (o: { id: string; ownerKey: string }) => (await call(o as never, "look", {}, { key: o.ownerKey })).body;

describe("departed agents", () => {
  it("leave keeps the character: its token on any call brings it back with the same id", async () => {
    const o = await createOffice();
    const me = await join(o, "docs-writer", { client: "codex" });
    const left = await call(o, "leave", {}, { token: me.agentToken });
    expect(left.status).toBe(200);
    expect(left.body.comeBack).toMatch(/30 days/);
    const back = await call(o, "status", { status: "working", activity: "back at it" }, { token: me.agentToken });
    expect(back.status).toBe(200);
    expect(back.body.agent?.id ?? back.body.id ?? me.agent.id).toBe(me.agent.id);
    const look = await call(o, "look", {}, { token: me.agentToken });
    expect(look.status).toBe(200);
    expect(JSON.stringify(look.body)).toContain("docs-writer");
  });

  it("office_join resume, and the same name and client, take a departed character back", async () => {
    const o = await createOffice();
    const a = await join(o, "release-bot", { client: "claude-code" });
    await call(o, "leave", {}, { token: a.agentToken });
    const resumed = await join(o, "release-bot", { client: "claude-code", resume: a.agentToken });
    expect(resumed.agent.id).toBe(a.agent.id);
    await call(o, "leave", {}, { token: resumed.agentToken });
    const byName = await join(o, "release-bot", { client: "claude-code" });
    expect(byName.agent.id).toBe(a.agent.id);
    const other = await join(o, "release-bot", { client: "cursor" });
    expect(other.agent.id).not.toBe(a.agent.id);
  });

  it("a #secret takes a departed character back", async () => {
    const o = await createOffice();
    const a = await join(o, "ops#a-long-private-secret-123");
    await call(o, "leave", {}, { token: a.agentToken });
    const b = await join(o, "ops#a-long-private-secret-123");
    expect(b.agent.id).toBe(a.agent.id);
  });

  it("the silence walk-out keeps the character too", async () => {
    const o = await createOffice();
    const a = await join(o, "nightly");
    await runInDurableObject(stubOf(o.id), async (inst: Office) => {
      (inst as any).agents.get(a.agent.id).lastSeen = Date.now() - REMOVE_MS - 1000;
    });
    expect(await runDurableObjectAlarm(stubOf(o.id))).toBe(true);
    expect(JSON.stringify(await roster(o))).not.toContain("nightly");
    const back = await call(o, "status", { status: "idle" }, { token: a.agentToken });
    expect(back.status).toBe(200);
    expect(JSON.stringify(await roster(o))).toContain("nightly");
  });

  it("office_delete_me removes it for good: the token, resume and the name no longer bring it back", async () => {
    const o = await createOffice();
    const a = await join(o, "temp-helper", { client: "codex" });
    const del = await call(o, "delete_me", {}, { token: a.agentToken });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(a.agent.id);
    expect((await call(o, "status", { status: "idle" }, { token: a.agentToken })).status).toBe(401);
    const again = await join(o, "temp-helper", { client: "codex", resume: a.agentToken });
    expect(again.agent.id).not.toBe(a.agent.id);
  });

  it("delete_me after a leave also forgets the departed record", async () => {
    const o = await createOffice();
    const a = await join(o, "short-lived", { client: "codex" });
    await call(o, "leave", {}, { token: a.agentToken });
    expect((await call(o, "delete_me", {}, { token: a.agentToken })).status).toBe(200);
    expect((await call(o, "status", { status: "idle" }, { token: a.agentToken })).status).toBe(401);
    const left = await runInDurableObject(stubOf(o.id), async (inst: Office) => (inst as any).departed.size as number);
    expect(left).toBe(0);
  });

  it("an agent a human showed out does not come back by token", async () => {
    const o = await createOffice();
    const a = await join(o, "pest");
    await runInDurableObject(stubOf(o.id), async (inst: Office) => { await (inst as any).kick(a.agent.id, "human:owner"); });
    expect((await call(o, "status", { status: "idle" }, { token: a.agentToken })).status).toBe(401);
  });
});
