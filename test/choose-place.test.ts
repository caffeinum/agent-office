// office_status at: an agent chooses its seat, station or desk instead of the office picking one.
import { describe, expect, it } from "vitest";
import { call, createOffice, join } from "./helpers";

const firstSpot = (look: any, list: "seats" | "stations") => String(look[list][0]).split(" ")[0]!;

describe("office_status at", () => {
  it("takes a seat or station id from office_look, shows it in look, and clears when omitted", async () => {
    const o = await createOffice();
    const a = await join(o, "lounger");
    const look = (await call(o, "look", {}, { token: a.agentToken })).body;
    const seat = firstSpot(look, "seats");
    const set = await call(o, "status", { status: "idle", at: seat }, { token: a.agentToken });
    expect(set.status).toBe(200);
    expect(set.body.agent.at).toBe(seat);
    const after = (await call(o, "look", {}, { token: a.agentToken })).body;
    expect(after.agents.find((x: any) => x.id === a.agent.id).at).toBe(seat);
    const cleared = await call(o, "status", { status: "working" }, { token: a.agentToken });
    expect(cleared.body.agent.at).toBeUndefined();
  });

  it("desk works for an agent with a desk; an unknown spot is a clear 404; a taken one a 409", async () => {
    const o = await createOffice();
    const a = await join(o, "a-agent");
    const b = await join(o, "b-agent");
    expect((await call(o, "status", { status: "idle", at: "desk" }, { token: a.agentToken })).body.agent.at).toBe("desk");
    const bad = await call(o, "status", { status: "idle", at: "nowhere-9" }, { token: a.agentToken });
    expect(bad.status).toBe(404);
    expect(bad.body.error).toMatch(/office_look/);
    const station = firstSpot((await call(o, "look", {}, { token: a.agentToken })).body, "stations");
    expect((await call(o, "status", { status: "idle", at: station }, { token: a.agentToken })).status).toBe(200);
    const taken = await call(o, "status", { status: "idle", at: station }, { token: b.agentToken });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toContain("a-agent");
    expect((await call(o, "status", { status: "idle", at: station }, { token: a.agentToken })).status).toBe(200); // re-choosing your own spot is fine
  });
});
