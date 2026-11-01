import { describe, expect, it } from "vitest";
import { legAt, MAX_PATH_POINTS, modeFor, normName, pathLength, positionAt, simplifyPath, uniqueName, Windows, type Pt } from "../src/city/walkers";

describe("walker math", () => {
  it("walks ≤300 blocks at 2/s and rides beyond at 8/s", () => {
    expect(modeFor(300)).toEqual({ mode: "walk", speed: 2 });
    expect(modeFor(300.1)).toEqual({ mode: "ride", speed: 8 });
  });

  it("interpolates x, z and y along the path and stops at the end", () => {
    const path: Pt[] = [[0, 0, 1], [10, 0, 1], [10, 10, 5]];
    expect(pathLength(path)).toBe(20);
    expect(positionAt(path, 2, 1000, 1000 + 2500)).toEqual({ p: [5, 0, 1], done: false });
    expect(positionAt(path, 2, 0, 7500).p).toEqual([10, 5, 3]);
    expect(positionAt(path, 2, 0, 60_000)).toEqual({ p: [10, 10, 5], done: true });
  });

  it("simplifies only straight-line points: corners, length and ends stay", () => {
    const zigzag: Pt[] = Array.from({ length: 200 }, (_, i) => [i, i % 2 ? 0.2 : 0, 1]);
    expect(simplifyPath(zigzag)).toEqual(zigzag);
    const straight: Pt[] = [[0, 0, 1], [1, 0, 1], [2, 0, 1], [2, 0, 1], [2, 3, 1], [2, 5, 2]];
    expect(simplifyPath(straight)).toEqual([[0, 0, 1], [2, 0, 1], [2, 3, 1], [2, 5, 2]]);
    expect(pathLength(simplifyPath(straight))).toBe(pathLength(straight));
  });

  it("splits a long route into ≤256-point legs that share their ends, timed along the full path", () => {
    const path: Pt[] = Array.from({ length: 600 }, (_, i) => [i, i % 2 ? 0.5 : 0, 1]);
    const speed = 2;
    const first = legAt(path, speed, 1000, 1000);
    expect(first).toEqual({ index: 0, from: 0, to: MAX_PATH_POINTS - 1, t0: 1000, last: false });
    const firstEnd = 1000 + (pathLength(path.slice(0, MAX_PATH_POINTS)) / speed) * 1000;
    const second = legAt(path, speed, 1000, firstEnd + 1);
    expect(second.index).toBe(1);
    expect(second.from).toBe(MAX_PATH_POINTS - 1);
    expect(second.t0).toBeCloseTo(firstEnd, 6);
    const end = legAt(path, speed, 1000, 1e12);
    expect(end).toMatchObject({ index: 2, to: 599, last: true });
    expect(end.to - end.from + 1).toBeLessThanOrEqual(MAX_PATH_POINTS);
    // the walker's position from its leg matches the full route
    const now = firstEnd + 20_000;
    const leg = legAt(path, speed, 1000, now);
    expect(positionAt(path.slice(leg.from, leg.to + 1), speed, leg.t0, now).p[0]).toBeCloseTo(positionAt(path, speed, 1000, now).p[0], 6);
  });

  it("numbers duplicate names like the office does and normalises for lookalikes", () => {
    expect(uniqueName("Bob", new Set(["bob", "bob2"]))).toBe("Bob 3");
    expect(uniqueName("B.o.b", new Set([normName("bob")]))).toBe("B.o.b 2");
    expect(normName("Example-Robotics!")).toBe(normName("example robotics"));
  });

  it("sliding windows report the wait", () => {
    const w = new Windows();
    const limits = [{ max: 1, ms: 2000 }, { max: 3, ms: 60_000 }];
    expect(w.take("k", limits, 0)).toBe(0);
    expect(w.take("k", limits, 1000)).toBe(1);
    expect(w.take("k", limits, 2000)).toBe(0);
    expect(w.take("k", limits, 4000)).toBe(0);
    expect(w.take("k", limits, 6000)).toBe(54);
  });
});
