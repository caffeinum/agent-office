import { describe, expect, it } from "vitest";
import { capPath, modeFor, normName, pathLength, positionAt, uniqueName, Windows, type Pt } from "../src/city/walkers";

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

  it("caps a path at 64 points keeping both ends", () => {
    const zigzag: Pt[] = Array.from({ length: 200 }, (_, i) => [i, i % 2 ? 0.2 : 0, 1]);
    const capped = capPath(zigzag);
    expect(capped).toHaveLength(64);
    expect(capped[0]).toEqual([0, 0, 1]);
    expect(capped.at(-1)).toEqual([199, 0.2, 1]);
  });

  it("numbers duplicate names like the office does and normalises for lookalikes", () => {
    expect(uniqueName("Bob", new Set(["bob", "bob 2"]))).toBe("Bob 3");
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
