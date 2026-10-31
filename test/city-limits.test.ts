import { beforeEach, describe, expect, it } from "vitest";
import { MAX_CITY_AGENTS, MAX_OFFICE_WALKERS } from "../src/city/walkers";
import type { CityResult } from "../src/city/do";
import { cityStub, setupCity, withCity } from "./city-harness";

beforeEach(() => setupCity());

const SITES = ["fixture-labs", "example-robotics", "sample-bakery"];
const officeId = (i: number) => `lim${String(i).padStart(9, "0")}`;

async function approvedOffice(i: number): Promise<string> {
  const id = officeId(i);
  const req = (await cityStub().requestLink(id, SITES[i % SITES.length]!, `Limits ${i}`)) as CityResult<unknown>;
  if (!req.ok) throw new Error(`requestLink ${id}: ${req.error}`);
  const ok = (await cityStub().decideLink(id, "approve")) as CityResult<unknown>;
  if (!ok.ok) throw new Error(`approve ${id}: ${ok.error}`);
  return id;
}

const look = async (office: string, agent: string) =>
  (await cityStub().call(office, { agentId: agent, name: `${office.slice(-4)} ${agent}`, hue: 1, status: "idle" }, { op: "look" })) as CityResult<unknown>;

describe("city caps", () => {
  it("refuses the 21st walker of one office and the 301st city-wide", async () => {
    const offices: string[] = [];
    try {
      const first = await approvedOffice(0);
      offices.push(first);
      for (let a = 0; a < MAX_OFFICE_WALKERS; a++) expect((await look(first, `a${a}`)).ok).toBe(true);
      const over = await look(first, "a-extra");
      expect(over).toMatchObject({ ok: false, status: 429 });
      expect((over as { error: string }).error).toContain(`${MAX_OFFICE_WALKERS}`);

      let present = await withCity((c) => (c as any).walkers.size as number);
      for (let i = 1; present < MAX_CITY_AGENTS; i++) {
        const id = await approvedOffice(i);
        offices.push(id);
        for (let a = 0; a < MAX_OFFICE_WALKERS && present < MAX_CITY_AGENTS; a++, present++) expect((await look(id, `a${a}`)).ok).toBe(true);
      }
      const extra = await approvedOffice(999);
      offices.push(extra);
      const full = await look(extra, "late");
      expect(full).toMatchObject({ ok: false, status: 429 });
      expect((full as { error: string }).error).toContain(`${MAX_CITY_AGENTS}`);
    } finally {
      for (const id of offices) await cityStub().officeGone(id);
    }
  });
});
