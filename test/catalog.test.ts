import { describe, expect, it } from "vitest";
import { applyOp, defaultLayout, findFreeSpot, footprint, GRID, KINDS, KIND_NAMES, MAX_ITEMS, validateLayout, type Item } from "../src/shared/catalog";

const REQUIRED = ["desk", "chair", "plant", "sofa", "lamp", "bookshelf", "rug", "whiteboard", "sign", "fridge", "coffee-machine", "table", "tv", "window", "poster", "server-rack", "beanbag"];

describe("catalog", () => {
  it("has every required kind and a 24x16 grid", () => {
    for (const k of REQUIRED) expect(KIND_NAMES).toContain(k);
    expect(GRID).toEqual({ w: 24, d: 16 });
    expect(KINDS.sign.textable).toBe(true);
    expect(KINDS.poster.textable).toBe(true);
  });

  it("default layout is valid and has 8 desks", () => {
    const items = defaultLayout(0);
    expect(() => validateLayout(items, GRID)).not.toThrow();
    expect(items.filter((i) => i.kind === "desk")).toHaveLength(8);
  });

  it("footprint swaps at 90/270", () => {
    expect(footprint({ kind: "sofa", x: 1, z: 1, rot: 0 })).toEqual({ x: 1, z: 1, w: 3, d: 1 });
    expect(footprint({ kind: "sofa", x: 1, z: 1, rot: 90 })).toEqual({ x: 1, z: 1, w: 1, d: 3 });
  });

  const items = defaultLayout(0);
  const opts = { grid: GRID, now: 1 };

  it("adds with a fresh id and stamps by/at", () => {
    const spot = findFreeSpot(items, GRID, "plant")!;
    const r = applyOp(items, { op: "add", kind: "plant", ...spot }, "a1", opts);
    expect(r.item).toMatchObject({ kind: "plant", by: "a1", at: 1, rot: 0 });
    expect(r.items).toHaveLength(items.length + 1);
    expect(items).toHaveLength(defaultLayout(0).length);
  });

  it.each([
    [{ op: "add", kind: "spaceship", x: 1, z: 1 }, /unknown kind/],
    [{ op: "add", kind: "plant", x: 99, z: 1 }, /out of bounds/],
    [{ op: "add", kind: "plant", x: -1, z: 1 }, /out of bounds/],
    [{ op: "add", kind: "plant", x: 1, z: 1, rot: 45 }, /bad rot/],
    [{ op: "add", kind: "plant", x: 1, z: 1, text: "hi" }, /has no text/],
    [{ op: "add", kind: "sign", x: 3, z: 13, text: "x".repeat(281) }, /max 280/],
    [{ op: "add", kind: "window", x: 3, z: 5 }, /hangs on a wall/],
    [{ op: "add", kind: "plant", x: 1, z: 1, color: "red" }, /bad color/],
    [{ op: "fly" }, /unknown op/],
    [{ op: "remove", id: "nope-1" }, /no item/],
    [{ op: "move", id: "desk-1", x: 1, z: 1, extra: 1 }, /unknown field/],
  ])("rejects %j", (op, msg) => {
    expect(() => applyOp(items, op as never, "a1", opts)).toThrow(msg);
  });

  it("rejects overlap on the same layer and allows it across layers", () => {
    const desk = items.find((i) => i.kind === "desk")!;
    expect(() => applyOp(items, { op: "add", kind: "plant", x: desk.x, z: desk.z }, "a1", opts)).toThrow(/overlaps/);
    const rug = items.find((i) => i.kind === "rug")!;
    expect(rug).toBeTruthy();
  });

  it("rejects duplicate ids", () => {
    const dup: Item[] = [...items, { ...items[0]! }];
    expect(() => validateLayout(dup, GRID)).toThrow(/duplicate/);
  });

  it("move / rotate / text / remove", () => {
    const sign = items.find((i) => i.kind === "sign")!;
    expect(applyOp(items, { op: "text", id: sign.id, text: "hello" }, "a1", opts).item?.text).toBe("hello");
    const plant = items.find((i) => i.kind === "plant")!;
    const spot = findFreeSpot(items, GRID, "plant")!;
    expect(applyOp(items, { op: "move", id: plant.id, ...spot }, "a1", opts).item).toMatchObject(spot);
    expect(applyOp(items, { op: "rotate", id: plant.id, rot: 90 }, "a1", opts).item?.rot).toBe(90);
    const r = applyOp(items, { op: "remove", id: plant.id }, "a1", opts);
    expect(r.removed).toBe(plant.id);
    expect(r.items.find((i) => i.id === plant.id)).toBeUndefined();
  });

  it("caps items", () => {
    const full: Item[] = Array.from({ length: MAX_ITEMS }, (_, i) => ({ id: `rug-${i + 1}`, kind: "rug", x: 0, z: 0, rot: 0, by: "t", at: 0 }));
    expect(() => applyOp(full, { op: "add", kind: "plant", x: 1, z: 1 }, "a1", opts)).toThrow(/full/);
  });
});
