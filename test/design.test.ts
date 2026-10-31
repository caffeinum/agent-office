// Pure shared design logic: theme schema + brand derivation, custom kind validation, seats/stations, design summary.
import { describe, expect, it } from "vitest";
import { applyOp, defaultLayout, footprint, GRID, KINDS, KIND_NAMES, validateLayout, type Item } from "../src/shared/catalog";
import {
  ACTIVITIES, allSpots, BOXES_MAX, brandTheme, DEFAULT_THEME, designSummary, mergeTheme, spotsOf, summarizeKind, validateKindDef, validateTheme,
  type CustomKind,
} from "../src/shared/design";

const BRAND = { primary: "#e94d3d", dark: "#141414", accent: "#d28f88" };

describe("theme", () => {
  it("default theme is valid and frozen", () => {
    expect(validateTheme(DEFAULT_THEME)).toEqual(DEFAULT_THEME);
    expect(Object.isFrozen(DEFAULT_THEME.floor)).toBe(true);
  });

  it("brandTheme is deterministic, complete and uses the brand colours", () => {
    const a = brandTheme(BRAND);
    expect(brandTheme(BRAND)).toEqual(a);
    expect(validateTheme(a)).toEqual(a);
    expect(a.accents).toEqual(["#e94d3d", "#d28f88", "#141414"]);
    expect(a.desk.rail).toBe("#e94d3d");
    expect(a.walls.accent).toMatchObject({ material: "brick", wall: "back" });
    expect(a.floor.material).toBe("concrete"); // near-black brand → polished concrete
    expect(a.lighting).toBe("warm"); // red primary
    expect(brandTheme({ primary: "#1e6bd6", dark: "#3a4a5a" })).toMatchObject({ lighting: "cool", floor: { material: "wood" } });
  });

  it("brandTheme fills in a missing dark/accent and keeps the logo", () => {
    const base = mergeTheme(DEFAULT_THEME, { logo: "a0123456789abcdef0123456" });
    const t = brandTheme({ primary: "#22aa55" }, base);
    expect(t.logo).toBe("a0123456789abcdef0123456");
    expect(t.accents).toHaveLength(3);
    expect(t.accents[0]).toBe("#22aa55");
  });

  it("walls stay light enough for any brand", () => {
    for (const primary of ["#000000", "#ffffff", "#ff0000", "#0000ff", "#7a00ff", "#00ffcc"]) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(brandTheme({ primary }).walls.color.slice(i, i + 2), 16));
      expect(Math.min(r!, g!, b!)).toBeGreaterThan(150);
    }
  });

  it("mergeTheme merges objects, replaces accents, removes the accent wall with null", () => {
    const t = mergeTheme(DEFAULT_THEME, { floor: { material: "carpet" }, walls: { accent: { color: "#aa3322" } }, accents: ["#123456"] });
    expect(t.floor).toEqual({ material: "carpet", color: DEFAULT_THEME.floor.color });
    expect(t.walls.accent).toEqual({ material: "brick", color: "#aa3322", wall: "back" });
    expect(t.accents).toEqual(["#123456"]);
    expect(mergeTheme(t, { walls: { accent: null } }).walls.accent).toBeNull();
    expect(DEFAULT_THEME.floor.material).toBe("wood");
  });

  it.each([
    [{ floor: { material: "lava" } }, /floor.material/],
    [{ floor: { color: "red" } }, /#rrggbb/],
    [{ accents: [] }, /1-4/],
    [{ accents: ["#111111", "#222222", "#333333", "#444444", "#555555"] }, /1-4/],
    [{ lighting: "disco" }, /lighting/],
    [{ logo: "../etc/passwd" }, /asset id/],
    [{ sparkles: true }, /unknown field "sparkles"/],
    [{ walls: { accent: { material: "marble", color: "#111111" } } }, /accent.material/],
  ])("rejects bad patch %j", (patch, re) => {
    expect(() => mergeTheme(DEFAULT_THEME, patch as never)).toThrow(re);
  });

  it("rejects bad brands", () => {
    expect(() => brandTheme({ primary: "red" })).toThrow(/brand.primary/);
    expect(() => brandTheme({ primary: "#ff0000", extra: "#000000" } as never)).toThrow(/unknown field/);
  });
});

const arcade = () => ({
  kind: "arcade-cabinet",
  label: "Arcade cabinet",
  footprint: { w: 1, d: 1 },
  boxes: [
    { x: 2, y: 0, z: 2, w: 12, h: 40, d: 12, color: "#141414" },
    { x: 3, y: 24, z: 13, w: 10, h: 10, d: 1, color: "#222222", material: "screen", emissive: true },
  ],
  stations: [{ x: 8, z: 24, rot: 180, activity: "play" }],
  screen: true,
});

describe("custom kinds", () => {
  it("validates and normalises", () => {
    const k = validateKindDef(arcade());
    expect(k).toMatchObject({ kind: "arcade-cabinet", w: 1, d: 1, layer: "object", screen: true, textable: false, custom: true, seats: [] });
    expect(k.boxes[1]).toEqual({ x: 3, y: 24, z: 13, w: 10, h: 10, d: 1, color: "#222222", material: "screen", emissive: true });
    expect(summarizeKind(k)).toMatchObject({ custom: true, boxes: 2, height: 40, colors: ["#141414", "#222222"] });
  });

  it.each([
    [{ kind: "desk" }, /built-in/],
    [{ kind: "Arcade" }, /slug/],
    [{ kind: "a" }, /slug/],
    [{ footprint: { w: 9, d: 1 } }, /footprint.w/],
    [{ boxes: [] }, /non-empty/],
    [{ boxes: [{ x: 10, y: 0, z: 0, w: 8, h: 4, d: 4, color: "#000000" }] }, /sticks out of the footprint along x/],
    [{ boxes: [{ x: 0, y: 0, z: 10, w: 4, h: 4, d: 8, color: "#000000" }] }, /along z/],
    [{ boxes: [{ x: 0, y: 60, z: 0, w: 4, h: 8, d: 4, color: "#000000" }] }, /too tall/],
    [{ boxes: [{ x: 0, y: 0, z: 0, w: 4, h: 65, d: 4, color: "#000000" }] }, /boxes\[0\].h/],
    [{ boxes: [{ x: 0.5, y: 0, z: 0, w: 4, h: 4, d: 4, color: "#000000" }] }, /integer/],
    [{ boxes: [{ x: 0, y: 0, z: 0, w: 4, h: 4, d: 4, color: "#000000", material: "chrome" }] }, /material/],
    [{ boxes: [{ x: 0, y: 0, z: 0, w: 4, h: 4, d: 4, color: "#000000", glow: 1 }] }, /unknown field "glow"/],
    [{ stations: [{ x: 8, z: 24, activity: "dance" }] }, /activity/],
    [{ stations: [{ x: 8, z: 40, activity: "play" }] }, /stations\[0\].z/],
    [{ seats: [{ x: 8, z: 8, rot: 45 }] }, /rot/],
    [{ evil: true }, /unknown field "evil"/],
  ])("rejects %j", (over, re) => {
    expect(() => validateKindDef({ ...arcade(), ...over })).toThrow(re);
  });

  it(`caps boxes at ${BOXES_MAX}`, () => {
    const box = { x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, color: "#000000" };
    expect(validateKindDef({ ...arcade(), boxes: new Array(BOXES_MAX).fill(box) }).boxes).toHaveLength(BOXES_MAX);
    expect(() => validateKindDef({ ...arcade(), boxes: new Array(BOXES_MAX + 1).fill(box) })).toThrow(/too many boxes/);
  });

  it("custom kinds place, collide and validate like built-ins", () => {
    const k = validateKindDef({ ...arcade(), footprint: { w: 2, d: 1 } });
    const custom = { [k.kind]: k };
    const items = defaultLayout(0);
    expect(() => applyOp(items, { op: "add", kind: "arcade-cabinet", x: 20, z: 10 }, "t")).toThrow(/unknown kind "arcade-cabinet"/);
    const r = applyOp(items, { op: "add", kind: "arcade-cabinet", x: 20, z: 10, rot: 90 }, "t", { kinds: custom });
    expect(r.item!.id).toBe("arcade-cabinet-1");
    expect(footprint(r.item!, custom)).toEqual({ x: 20, z: 10, w: 1, d: 2 });
    expect(() => applyOp(r.items, { op: "add", kind: "plant", x: 20, z: 11 }, "t", { kinds: custom })).toThrow(/overlaps arcade-cabinet/);
    expect(() => applyOp(r.items, { op: "text", id: "arcade-cabinet-1", text: "hi" }, "t", { kinds: custom })).toThrow(/has no text/);
    expect(() => validateLayout(r.items, GRID, custom)).not.toThrow();
  });
});

describe("seats & stations", () => {
  it("built-ins declare sensible spots, all valid", () => {
    expect(KINDS.sofa.seats).toHaveLength(3);
    expect(KINDS.beanbag.seats).toHaveLength(1);
    expect(KINDS.chair.seats).toHaveLength(1);
    expect(KINDS["coffee-machine"].stations?.[0]?.activity).toBe("coffee");
    expect(KINDS.bookshelf.stations?.[0]?.activity).toBe("read");
    expect(KINDS.plant.stations?.[0]?.activity).toBe("water-plants");
    expect(KINDS.whiteboard.stations?.[0]?.activity).toBe("whiteboard");
    expect(KINDS.tv.stations?.[0]?.activity).toBe("watch");
    for (const name of KIND_NAMES) {
      const k = KINDS[name];
      for (const s of k.stations ?? []) expect(ACTIVITIES).toContain(s.activity);
      // re-validating through the custom-kind validator proves built-ins follow the same rules
      if (k.seats || k.stations) {
        expect(() =>
          validateKindDef({ kind: `x-${name}`, label: k.label, footprint: { w: k.w, d: k.d }, boxes: [{ x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, color: "#000000" }], seats: k.seats, stations: k.stations }),
        ).not.toThrow();
      }
    }
  });

  it("spotsOf rotates with the item and stays near it", () => {
    for (const rot of [0, 90, 180, 270] as const) {
      const sofa = { id: "sofa-9", kind: "sofa", x: 5, z: 5, rot };
      const { seats } = spotsOf(sofa);
      const f = footprint(sofa);
      expect(seats.map((s) => s.id)).toEqual(["sofa-9:s0", "sofa-9:s1", "sofa-9:s2"]);
      for (const s of seats) {
        expect(s.x).toBeGreaterThanOrEqual(f.x);
        expect(s.x).toBeLessThanOrEqual(f.x + f.w);
        expect(s.z).toBeGreaterThanOrEqual(f.z);
        expect(s.z).toBeLessThanOrEqual(f.z + f.d);
        expect(s.yaw).toBeCloseTo((rot * Math.PI) / 180, 1);
      }
    }
    const coffee = spotsOf({ id: "c", kind: "coffee-machine", x: 1, z: 0, rot: 0 }).stations[0]!;
    expect(coffee).toMatchObject({ id: "c:t0", activity: "coffee", x: 1.5, duration: 25 });
    expect(coffee.z).toBeGreaterThan(1); // stands in front of the machine
    expect(coffee.yaw).toBeCloseTo(Math.PI, 2); // facing it
  });

  it("allSpots counts built-in and custom spots", () => {
    const k = validateKindDef(arcade()) as CustomKind;
    const items: Item[] = [...defaultLayout(0), { id: "arcade-cabinet-1", kind: "arcade-cabinet", x: 20, z: 10, rot: 0, by: "t", at: 0 }];
    const base = allSpots(defaultLayout(0));
    const more = allSpots(items, { [k.kind]: k });
    expect(more.stations.length).toBe(base.stations.length + 1);
    expect(more.stations.at(-1)).toMatchObject({ activity: "play", item: "arcade-cabinet-1" });
    expect(base.seats.length).toBe(7); // 2 chairs + 3 sofa seats + 2 beanbags
  });
});

describe("design summary", () => {
  it("names zones, measures free floor and counts spots", () => {
    const d = designSummary({ grid: GRID, items: defaultLayout(0), theme: DEFAULT_THEME });
    expect(d.theme).toMatch(/wood floor/);
    const names = d.zones.map((z) => z.name);
    expect(names).toContain("work");
    expect(names).toContain("kitchen");
    expect(names).toContain("lounge");
    expect(d.zones.find((z) => z.name === "work")).toMatchObject({ kinds: "desk×8 plant", items: 9 });
    expect(d.scattered).toMatch(/plant/);
    expect(d.freeFloor.cells).toBeGreaterThan(200);
    expect(d.freeFloor.largestOpen.w * d.freeFloor.largestOpen.d).toBeGreaterThan(20);
    expect(d.seats).toBe(7);
    expect(d.stationsByActivity.coffee).toBe(1);
  });

  it("a custom arcade cluster is named arcade", () => {
    const k = validateKindDef(arcade());
    const items: Item[] = [
      { id: "arcade-cabinet-1", kind: "arcade-cabinet", x: 2, z: 2, rot: 0, by: "t", at: 0 },
      { id: "arcade-cabinet-2", kind: "arcade-cabinet", x: 3, z: 2, rot: 0, by: "t", at: 0 },
      { id: "beanbag-1", kind: "beanbag", x: 2, z: 4, rot: 0, by: "t", at: 0 },
    ];
    const d = designSummary({ items, custom: { [k.kind]: k } });
    expect(d.zones).toHaveLength(1);
    expect(d.zones[0]).toMatchObject({ name: "arcade", tags: ["arcade", "lounge"], items: 3, stations: 2, seats: 1 });
    expect(d.customKinds).toBe(1);
  });

  it("a mixed cluster is named by its dominant tag and keeps every tag", () => {
    const k = validateKindDef(arcade());
    const items = [
      ...defaultLayout(0),
      { id: "arcade-cabinet-1", kind: "arcade-cabinet", x: 21, z: 8, rot: 0, by: "t", at: 0 },
      { id: "arcade-cabinet-2", kind: "arcade-cabinet", x: 22, z: 8, rot: 0, by: "t", at: 0 },
    ] as Item[];
    const lounge = designSummary({ items, custom: { [k.kind]: k } }).zones.find((z) => z.tags.includes("arcade"));
    expect(lounge?.name).toBe("lounge");
    expect(lounge?.tags.slice(0, 2)).toEqual(["lounge", "arcade"]);
  });

  it("the default office has no unreachable spots; blocked and off-floor ones are listed, not counted", () => {
    const base = designSummary({ items: defaultLayout(0) });
    expect(base.unreachable).toEqual([]);
    const items = [
      ...defaultLayout(0),
      { id: "plant-front", kind: "plant", x: 5, z: 15, rot: 0, by: "t", at: 0 },
      { id: "chair-blocker", kind: "chair", x: 0, z: 3, rot: 0, by: "t", at: 0 },
    ] as Item[];
    const d = designSummary({ items });
    expect(d.unreachable.sort()).toEqual(["plant-front:t0", "table-1:t0"]);
    expect(d.stations).toBe(base.stations - 1);
    expect(d.seats).toBe(base.seats + 1);
  });
});
