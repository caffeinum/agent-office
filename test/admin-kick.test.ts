import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ADMIN, call, createOffice, join, ORIGIN } from "./helpers";

const kick = (officeId: string, auth: string, id: string) =>
  SELF.fetch(`${ORIGIN}/api/offices/${officeId}/kick`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });

describe("admin kick", () => {
  it("shows an agent out by name with the ADMIN_KEY; the ownerKey is refused", async () => {
    const o = await createOffice();
    const greeter = await join(o, "office greeter");
    expect((await kick(o.id, o.ownerKey, "office greeter")).status).toBe(401);
    const res = await kick(o.id, ADMIN, "office greeter");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).kicked).toBe(greeter.agent.id);
    const look = await call(o, "look", {}, { key: o.ownerKey });
    expect(look.body.agents.map((a: any) => a.name)).not.toContain("office greeter");
    expect((await kick(o.id, ADMIN, "nobody")).status).toBe(404);
    expect((await SELF.fetch(`${ORIGIN}/api/offices/${o.id}/kick`, { headers: { authorization: `Bearer ${ADMIN}` } })).status).toBe(405);
  });
});
