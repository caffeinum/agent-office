import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module without types
import { BABBLE_GAP_MS, BABBLE_MAX_SYLLABLES, SOUND_GAP_MS, cueGate, soundCues } from "../public/js/sound-plan.js";

const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, status: "idle", hue: 10, ...extra });
const item = (id: string, x = 1, z = 1, rot = 0) => ({ id, kind: "desk", x, z, rot });
const office = (agents: unknown[] = [], items: unknown[] = []) => ({ agents, items });

describe("soundCues", () => {
  it("the snapshot and the first frame before it make no sound", () => {
    expect(soundCues(null, { type: "agent", agent: agent("a") }, office([agent("a")]))).toEqual([]);
    expect(soundCues(office(), { type: "snapshot" }, office([agent("a")]))).toEqual([]);
  });

  it("an agent walking in pops, walking out pops down, but only if it was here", () => {
    expect(soundCues(office(), { type: "agent", agent: agent("a") }, office([agent("a")]))).toEqual([{ sound: "join", agent: "a" }]);
    expect(soundCues(office([agent("a")]), { type: "agent-left", id: "a" }, office())).toEqual([{ sound: "leave", agent: "a" }]);
    expect(soundCues(office(), { type: "agent-left", id: "ghost" }, office())).toEqual([]);
  });

  it("dings once when an agent starts waiting, not on every update while it waits", () => {
    const before = office([agent("a", { status: "working" })]);
    expect(soundCues(before, { type: "agent", agent: agent("a", { status: "waiting" }) }, office())).toEqual([{ sound: "ding", agent: "a" }]);
    const waiting = office([agent("a", { status: "waiting" })]);
    expect(soundCues(waiting, { type: "agent", agent: agent("a", { status: "waiting", activity: "still" }) }, office())).toEqual([]);
  });

  it("babbles a new speech bubble with the agent's own voice, short, rising for a question", () => {
    const before = office([agent("a")]);
    const [cue] = soundCues(before, { type: "agent", agent: agent("a", { says: { text: "ready?", ts: 5 } }) }, office());
    expect(cue).toMatchObject({ sound: "babble", agent: "a", syllables: 3, question: true });
    expect(typeof cue.voice).toBe("number");
    const long = soundCues(before, { type: "agent", agent: agent("a", { says: { text: "x".repeat(200), ts: 5 } }) }, office());
    expect(long[0].syllables).toBe(BABBLE_MAX_SYLLABLES);
    const same = office([agent("a", { says: { text: "hi", ts: 5 } })]);
    expect(soundCues(same, { type: "agent", agent: agent("a", { says: { text: "hi", ts: 5 }, activity: "x" }) }, office())).toEqual([]);
  });

  it("placing or moving furniture thunks, removing it crunches, a no-op update is silent", () => {
    expect(soundCues(office(), { type: "item", item: item("d", 3, 4) }, office())).toEqual([{ sound: "place", x: 3, z: 4 }]);
    const has = office([], [item("d", 3, 4)]);
    expect(soundCues(has, { type: "item", item: item("d", 5, 4) }, office())).toEqual([{ sound: "place", x: 5, z: 4 }]);
    expect(soundCues(has, { type: "item", item: item("d", 3, 4) }, office())).toEqual([]);
    expect(soundCues(has, { type: "item-removed", id: "d" }, office())).toEqual([{ sound: "break", x: 3, z: 4 }]);
  });
});

describe("cueGate", () => {
  it("lets one sound of a kind through per gap, and one babble per agent per gap", () => {
    const pass = cueGate();
    expect(pass({ sound: "place" }, 0)).toBe(true);
    expect(pass({ sound: "place" }, SOUND_GAP_MS - 1)).toBe(false);
    expect(pass({ sound: "break" }, 10)).toBe(true);
    expect(pass({ sound: "place" }, SOUND_GAP_MS)).toBe(true);
    expect(pass({ sound: "babble", agent: "a" }, 0)).toBe(true);
    expect(pass({ sound: "babble", agent: "b" }, 1)).toBe(true);
    expect(pass({ sound: "babble", agent: "a" }, BABBLE_GAP_MS - 1)).toBe(false);
    expect(pass({ sound: "babble", agent: "a" }, BABBLE_GAP_MS)).toBe(true);
  });
});
