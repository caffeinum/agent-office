> **Operator decisions recorded 2026-10-31 13:26–13:35 (agent-office):** grid = **option a** (rigid rotation to the SoMa grid, rotDeg ≈ 44.7°; FiDi/North Beach/Marina/Presidio go diagonal) — W1 is unblocked. Ground elevation stays real (1:1) by default, but expose a `terrainExaggeration` build-config knob (default 1.0) and make hills read better via shading/terracing; the operator may ask for 1.5–2×. Add **Y Combinator** (current SF address, sourced) and retry Stripe, Dropbox, Scale AI, Notion, Plaid. Firegoat stays at 501 2nd St (operator source).

# sf voxel city v2: build spec (extends v1.1)

> **Status (2026-10-31): planned, revision 2.** This spec extends `docs/city/spec.md` (v1.1). Every v1 rule stays in force unless a section below replaces it by number. Nothing in the repo changed while this was written.
>
> - **Day 0 (blocks W1):** the operator picks the grid option (§1.3). W1 does not freeze anchors until that pick is recorded here.
> - **Start:** v2 work starts only after the concurrent v1 polish lands on `main`. W1 rebases on that commit and records its sha here.
>
> **Revision 2 changes:**
> - Grid decision moved to day 0, with the SoMa tradeoff stated and c1 costed.
> - City access moved into a single `office_city` tool on the existing office MCP. The separate city MCP server, city passes and open join are dropped.
> - DO storage, walker lifecycle and abuse limits are specified.
> - Walk graph carries y.
> - Building entry is 20 bytes, with a parent id and an accent band.
> - Ownership gaps closed and the merge order made acyclic.
> - Heights are generated, not typed.
> - Sutro is cut. Coarse terrain covers unbuilt land.

## 0. operator feedback → decisions

| # | feedback (verbatim) | decision | section |
|---|---|---|---|
| F1 | "as a map for our characters, they should also be able to join here" | Add a City Durable Object. (1) A presence bridge: agents of a linked office stand at their company's building, with nothing for the agent to do. (2) One new tool, `office_city {op: go\|look\|chat}`, on the office MCP that agents already have, so any joined agent can walk the streets without a second MCP server. The viewer is public and watch-only. | §7 |
| F2 | "buildings are wrong -- see pictures of sf skyline and match it" | Chunk format v2 gets a per-column roof-height layer. Fetch OSM `building:part`. New height-priority rules. 22 hand-made landmark recipes with heights generated from the Wikipedia table. A stone/precast palette replaces blue glass. Gate: the top-50 skyline check. | §3, §4, §5 |
| F3 | "put Firegoat at 501 2nd St" | Already in `companies.src.json` (`firegoat-501-2nd`, operator source, commit b869c8f) and already shipping in v1 `companies.json`. v2 re-anchors it after the rebuild, pins it to the EAS point for 501 2nd St in a check, and makes it the first office↔site link. | §6 |
| F4 | "instead of stadium you made a big apartment building" | Oracle Park gets a ballpark recipe: bowl, field, stands, light towers, no window atlas. Chase Center gets an arena recipe. Generic structure classes cover piers, the ferry tower, churches, parking and canopies. | §5 |
| F5 | "the grid is diagonal, i was thinking straight" | The projection gets a rigid rotation `rotDeg`, or per-district frames (c1). No single rotation straightens both FiDi and the Transbay/SoMa cluster where the tallest towers and Firegoat stand. The operator picks on day 0 (§1.3) from options that state this plainly. | §1 |
| F6 | "map presidio as well" | The extent grows west to the Presidio, Crissy Field, Fort Point, Marina, Cow Hollow, Pac Heights and Presidio Heights. The Golden Gate Bridge south half goes in as a landmark mesh. Lincoln Park is not included. | §2 |

**One rebuild.** The grid, the extent, format v2 and the data fixes all ship in a single rebuild. Every block coordinate changes once, never twice.

## 1. grid and projection (replaces v1 §1 "Projection", the reserved grid and the anchor table)

### 1.1 Mechanism (options a, b, d; c1 extends it in §1.4)

`SF_PROJ` gains `rotDeg`, `pivotX`, `pivotZ`, `x0`, `z0`:

```
(xe, ze) = v1 equirect (lon, lat)                      // unchanged math, unrotated
x = c·(xe−pivotX) − s·(ze−pivotZ) + x0
z = s·(xe−pivotX) + c·(ze−pivotZ) + z0                 // c,s = cos,sin(rotDeg)
```

- The inverse is exact. 1 block = 3 m still holds, because the map is rigid.
- The pivot is the city centre (−122.4385, 37.7715). In v1 equirect that is pivotX 2390.6, pivotZ 2340.5.
- `x0` and `z0` are chosen so that the rotated full-city box (lon −122.52..−122.3569, lat 37.708..37.845) plus a 64-block margin on each side lands in positive coordinates, rounded up to a multiple of 64. The reserved grid is `ceil((extent + 128) / 64)` chunks per axis.
- **All numbers below are provisional. Do not copy them into code.** W1 computes them from the formulas, freezes them in `format.check.mjs`, and replaces this table. The first draft got them wrong; the values below are the review's recomputation.

  | option | rotDeg | reserved grid (chunks) | Salesforce | Fort Point |
  |---|---|---|---|---|
  | d | 9.2 | 89×93 | (4128.9, 2661.6) | (1928.8, 1532.4) |
  | a | 44.7 | 112×112 | W1 computes | W1 computes |
  | b | 0 | 76×74 (v1 values unchanged; pivot 0, x0 0, z0 0) | v1 | v1 |

- The manifest carries `proj`. The viewer, the build, the City DO and every check go only through `lonLatToBlock` and `blockToLonLat`. Any other projection math is a bug.
- §1 no longer promises a "fixed projection forever". The new rule: the projection is fixed per `CITY_VERSION`, and durable data stores lat/lon or ids, never block coordinates (§7.7).
- The anchor table is recomputed by W1 and asserted in `format.check.mjs` (0.2 blocks, exact chunk). It covers Salesforce, Ferry Building, Transamerica, Grace Cathedral, Coit, Pier 39, Ghirardelli, OpenAI, Firegoat and Fort Point.
- With rotDeg ≠ 0, a compass/north arrow in the UI is mandatory, and the spawn azimuth is re-pinned.

### 1.2 What each option straightens

Measured on cached v1 OSM roads. "Clean" means within ±1.5° of an axis. The jog figures are staircase jogs per 100 m.

The city has two street grids. North of Market, FiDi, North Beach, Nob Hill, the Marina and Pac Heights run about 9° off north. South of Market, SoMa and the Transbay/Rincon cluster run about 45° off. **The Transbay cluster (Fremont, Beale, Main, Mission, Folsom near Transbay) holds Salesforce, 181 Fremont, Millennium, Park Tower, The Avery, 50 Fremont and One Rincon Hill, plus Firegoat's block at 501 2nd St.** No single rotation straightens both grids.

| option | what it is | clean road | jogs/100 m | north of Market (FiDi, Marina, Presidio) | Transbay towers + Firegoat | extra time |
|---|---|---|---|---|---|---|
| **a** | rigid rotation to the SoMa grid, rotDeg 44.7 | 21% | 14.8 | 35.5° off, staircase. Transamerica, 555 California and the Embarcadero Center staircase | **straight** | 0 |
| **b** | keep north-up, rotDeg 0 | 0.7% | 9.5 | 9.2° off | 44.7° off | −0.5 d |
| **c1** | per-district rigid frames: frame 0 at 9.2°, frame 1 at 44.7° south of Market | ~79% | 2.7 | **straight** | **straight** | **+5–7 d** (W2 +3, W4 +3, W1 +0.5) |
| **d** | rigid rotation to the downtown grid, rotDeg 9.2 | 36% | 6.8 | **straight** (88% of roads north of Market) | **35–36° off, staircase** | 0 |

- **Continuous warp (c2): rejected.** It shears the FiDi/SoMa skyline about 35° across Market St, which contradicts F2.
- "Downtown straight" under d means north of Market only. Under d, the skyline's tallest cluster and Firegoat render as diagonal staircases.

### 1.3 Day-0 decision (blocks W1)

The integrator sends the operator this message verbatim, with one screenshot per option taken from the v1 viewer with a temporary rotation:

> one rotation can't straighten both halves of downtown. pick one:
> - **d** (9.2°): FiDi, Marina, Presidio straight; Salesforce/Transbay towers and Firegoat diagonal. no extra time.
> - **a** (44.7°): Salesforce/Transbay and Firegoat straight; FiDi, Transamerica, Marina, Presidio diagonal. no extra time.
> - **c1** (two frames, seam under Market St): both straight. +5–7 days.
> - **b** (north-up): nothing straight.

- The answer is recorded in this status block before W1 starts.
- **Recommendation: c1 if the 5–7 days are acceptable.** It is the only option that satisfies "straight" where the showcase is (SoMa skyline, Firegoat) and in the new Presidio/Marina area. If time is fixed, the recommendation is **a**, because the skyline and Firegoat matter more to F2 and F3 than the FiDi street pattern. The previous revision recommended d; d stays available, with its tradeoff stated plainly.
- If a, b or d is picked, the only change is the constant. W1 still reserves `frame` as a u8 that must equal 0.

### 1.4 c1 details (only if picked)

| workstream | change |
|---|---|
| W1 | chunk header `frame` u8 (§4); `manifest.frames: [{id, rotDeg, pivot, x0, z0, polygon}]`; chunk keys become `f:cx,cz`; `lonLatToBlock` returns `{frame, x, z}` and also world `(wx, wz)` in frame 0 |
| W2 | rasterize per frame. Frames are clipped to district polygons, with seams under Market St (smooth 11-block road ribbon), the US-101 Division/13th St viaduct and Mission Creek. Buildings are assigned to a frame by centroid |
| W4 | one THREE.Group per frame. `groundAt`, `pick` and LOD rings go through the frame transform. Draws the Market ribbon mesh |
| W5, W6, W7 | no change. The walk graph and the server use world coordinates (frame 0), and walkers cross seams in world space |

## 2. extent: Presidio and the west (replaces v1 §1 "v1 area" and the BBOX/CHUNK_MIN/MAX config)

- `config.mjs` replaces `CHUNK_MIN/MAX/BBOX/FETCH_BBOX` with `AREAS`, a list of lon/lat boxes:
  - `east`: the v1 bbox, lon −122.42836..−122.38254, lat 37.75513..37.81069.
  - `west`: lon −122.4860..−122.4284, lat 37.7840..37.8125. It covers the Presidio, Crissy Field, Fort Point, Marina, Cow Hollow, Pac Heights, Presidio Heights, the Sea Cliff edge and the Golden Gate south abutment. **Lincoln Park (about −122.50) is outside it and is not part of v2.**
- **Fetches.** Each area is fetched into its own raw file (Overpass, DataSF footprints and Terrarium; 25 new tiles). On merge, records are deduped by OSM id and by DataSF `area_id`. Overpass keeps its 24 h cooldown and the fetch UA, so W2 runs the new fetch on day 1.
  - A coarse Terrarium fetch at z12 covers the whole reserved grid, for the unbuilt-land relief below.
- **Chunk list.** Shipped chunks are every chunk of the grid whose 8×8 sample hits (union of the areas) ∩ land. Expect about 980 chunks and about 1.45 MB (0.45–0.6 MB of that is new).
- **Water, unbuilt land and unmapped area.** This replaces v1's "unlisted inside min/max = water" rule. The manifest gains:
  - `water: [[cx,cz],…]`: in-area chunks that are entirely water. They are not shipped and render as sea.
  - `landmask`: the path to `landmask.bin` (`SFM1`). It stores 1 byte per 4×4-block cell over the whole reserved grid. 0 means sea. 1–255 means land, with the value equal to the coarse ground height in blocks + 1, clamped. It is built from the j2bu-swwd citywide mask and the z12 Terrarium. Expect about 45 KB gzipped.
  - Outside the listed and water chunks, the viewer draws mask land as a low-relief "unbuilt" terrain in a muted paper tone, with each cell at its coarse height, and draws the rest as sea. The Western Addition/Haight gap reads as unbuilt land, not bay.
  - **Seam rule.** Where a listed chunk borders unbuilt land, the listed chunk's edge columns draw a skirt: vertical faces in the paper tone, down from their ground to the neighbouring cell's coarse height. The coarse field is sampled from the same Terrarium data, so skirts stay small: under 2 blocks at the 90th percentile, which `verify-sf` asserts. There is no flat y=1 plane, and no cliffs to y=1.
- **Budgets.** `files` 700 → 1300. `totalBytes` stays 8 MB. The LOD2 gate stays at ≤1.5M triangles after culling; W4 must prove it with `perf.mjs` at spawn and at a Presidio overview.
- **Presidio data.** The DataSF+OSM merge applies unchanged. `deckY` overrides for the Presidio Parkway viaducts (32 `bridge=yes` trunk/primary ways) come from OSM `layer` plus the bank ground. `leisure=dog_park` maps to GRASS.
- **Companies.** ILM/Lucasfilm at Letterman moves from skipped to `ship:true` if its sources pass the v1 rules.
- **New verify points:**
  - Fort Point: land/water edge.
  - Palace of Fine Arts lagoon: WATER.
  - Crissy Field beach: SAND.
  - Presidio Main Post: land, ground 3–8.
  - Golden Gate Bridge south tower: present in `landmarks.bin`.

## 3. pipeline changes (W2; amends v1 §2)

1. **Overpass.** Add these queries:
   - `wr["building:part"](bbox); out geom;`
   - `wr[leisure~"^(stadium|track|sports_centre)$"]`
   - nodes `tower:type=lighting` and `man_made~"^(mast|tower|flagpole)$"`
   - `natural=tree` nodes
   - add `busway` to the road query.
2. **`keepBuilding(tags)`** in `osm.mjs` drops buildings with `layer<0`, `location=underground`, or `building:levels=0` with no height. This removes the Civic Center, Powell, Montgomery and Embarcadero station slabs. Every dropped id is logged in `report.json` as `droppedUnderground`. The check fails if a dropped building has no DataSF coverage and no `location=underground` tag.
3. **`loadBuildings`** keeps `hgt_maxcm`, the full OSM tags and the structure kind on every record. This is the `ctx.osm` shape frozen by W1 (§8). W3 depends on it.
4. **Height priority.** This replaces the v1 merge rule. Highest wins:
   1. a `landmarks.json` recipe (W3)
   2. an OSM `building:part`
   3. an OSM outline with height > 60 m, or `start_date` > 2010, or a structure kind, or DataSF `hgt_maxcm/100 − hgt_median_m` > 40 m. The OSM polygon is used, and every DataSF parcel whose centroid lies inside it is deleted (logged as `deletedParcels`). This deletes the 1.5× area rule.
   4. DataSF `hgt_median_m`
   5. OSM levels × 3.5 m, or 4 m per level for office parts with ≥10 levels
   6. 9 m
   - An OSM height is never copied onto a DataSF parcel that is more than 1.2× its area or whose centroid lies outside it. This fixes the Salesforce 27×27 parcel, 181 Fremont split in two, and parcel 16340.
5. **`building:part` rasterization.** Each part is a prism from `min_height` (or `building:min_level`×3.5) to `height` (or levels×3.5). Format v2 stores one `[base, top]` span per column, so:
   - Parts whose span touches or overlaps the column's ground-attached span are merged: the column top becomes the maximum.
   - Parts that float above a gap (`min_height` above the current column top: overhangs, skybridges, open crowns) are **dropped from chunks** and logged as `droppedFloatingParts`. The only exception is a part named in a landmark's `mesh` op (for example the Salesforce lattice crown), which goes to `landmarks.bin`.
   - Inside a part, the outline height no longer applies. The result is written to the v2 `top` layer.
6. **Contradiction report.** `levels<10` together with DataSF max > 100 m, or a DataSF max − median gap > 40 m with no part or landmark, is listed as `unresolvedTower` in `report.json`. **Gate:** zero unresolved towers in the top-50 list.
7. **Landcover fixes:**
   - `parking=underground` or `layer<0` parking is skipped (Union Square).
   - Paved `leisure=park` maps to PLAZA.
   - `leisure=pitch` maps by surface: asphalt/concrete → COURT, tartan → TRACK, otherwise GRASS.
   - `natural=sand` with baseball, or with `surface=dirt`, maps to DIRT.
   - Water that is a fountain or pond, or has `layer>=1`, on mask land maps to POOL. POOL keeps its ground and is not a water surface, so the "water iff ground 0" invariant holds.
   - PIER colour becomes concrete grey.
8. **Bridges and decks:**
   - Any way with `bridge` other than `no` (all road classes, rail, busway) and under 300 m becomes a deck, allowed over water, with pillars on the banks. This fixes the 4th St bridge and the Transbay ramp (layer 1 → +3, layer 2 → +5).
   - The v1 "no deck over open water" rule and the `MAX_DECK_WATER` gate change to "only bridge ways under 300 m".
   - The deck top per way is written to `report.json` `decks: {wayId: deckY}`. W5 reads it for walk-graph y (§7.6).
   - The Bay Bridge and Golden Gate decks come from `landmarks.bin`, never from chunks. The OSM Bay Bridge tower ways (w432712476, w432712477) are dropped as buildings.
9. **Palette.** W1 implements this in `paletteFor` in `public/shared/city.js` (W1 owns that file); W2 only calls it.
   - The >30-block group becomes stone/precast: #e6e1d6, #d9d4c9, #cfc8bb, #bfb8ab. About 25% of it is blue-grey glass: #8ea3b3, #6f8799.
   - `paletteFor(height, id, {colour?, material?, structure?})`: `building:colour` and `building:material` are honoured when present, mapped to the nearest `BUILDING_PALETTE` entry.
   - Structures (≤4 blocks with a kind) never get the pastel Victorian group.
10. **Hooks into W3.** The hooks are frozen in W1 stubs; at first they are no-ops that return the raster unchanged and an empty mesh:
    - `build-sf.mjs` calls `applyStructures(raster, ctx)` after `stampBuildings` and before `finishDecks`.
    - It calls `applyLandmarks(raster, ctx)` last, before encode.
    - It then calls `buildLandmarkMesh(ctx) → Uint8Array` and writes the result to `public/city/sf/landmarks.bin`.
    - `ctx = {proj, groundAt(x,z), osm, datasf, report}`.
    - The raster API exposes `setColumn(x, z, {bldg, base, top})`, `setSurface(x, z, id)`, `clearBuilding(x, z)` and `addEntry(entry) → id`. W3 may write the surface layer through `setSurface`.
    - Every column a landmark writes clears other buildings' ids inside its outline, so the landmark wins.

## 4. format v2 (W1; replaces v1 §2 chunk format, manifest and validation)

`CITY_VERSION = 2`. A v1 viewer must throw `city chunk version 2, this viewer reads 1`, and a v2 viewer given a v1 chunk throws the mirror message.

**Chunk (magic `SFC1` is kept, version 2):**

- **Header (16 bytes):**
  - the v1 fields as before
  - byte 14 (u8): `frame`, must be 0 unless c1 is taken
  - byte 15 (u8): reserved, must be 0
- **Layers:** the v1 layers plus `top: Int16[4096]`. The rules:
  - `top[i] > base` if and only if `bldg[i] ≠ 0`; otherwise `top[i] == 0`.
  - `top[i] ≤ entry.top`.
  - `entry.top == max(top[i])` over that entry's columns in the chunk.
- **Building entry (20 bytes; v1 was 12):**

  | bytes | v2 field | v1 meaning |
  |---|---|---|
  | 0–3 | `id u32` | same |
  | 4–7 | `parent u32` (0 = none) | new |
  | 8–9 | `base i16` | same |
  | 10–11 | `top i16` (max) | same |
  | 12–13 | `accentFrom i16`: side faces at y ≥ this use `accent`; 0x7fff = none | new |
  | 14 | `palette u8` | same |
  | 15 | `cap u8` | **renamed from v1 `roof`**, which v1 validated to be 0 |
  | 16 | `facade u8` | **was the low byte of v1's reserved u16** |
  | 17 | `accent u8` | **was the high byte of v1's reserved u16** |
  | 18–19 | reserved u16, must be 0 | new |

  - `cap`: 0 flat, 1 crown (lighter), 2 spire (metal), 3 dome, 4 green roof, 5 seats. It applies to the column's top face only.
  - `facade`: 0 window atlas, 1 blank, 2 ribbed, 3 open-deck parking, 4 brick arcade, 5 glass curtain.
  - `accent`: a palette index used for cap faces and for side faces at y ≥ `accentFrom`.
- **Per-column and per-height styling:**
  - Styling that differs by column becomes separate entries sharing a `parent`. Examples: the Ferry shed (arcade) vs the clock tower (dome), Moscone's green part vs its plain roof, a ballpark's stands vs its scoreboard.
  - Styling that differs by height on the same columns uses `accentFrom`. Example: the Salesforce crown band from y99.
  - `pick` and labels resolve an entry to `parent || id`, so one landmark picks as one building.
- **Props section** (count stored as u16 after the building table): 8 bytes each, `{lx u8, lz u8, y0 i16, y1 i16, color u8, flags u8 (1 = emissive)}`.
  - Used for ballpark light towers, masts, flagpoles, the clock-tower flagpole and 1×1 spires.
  - Chunk-local, so pick and LOD work per chunk.
  - **Oracle Park light towers are chunk props only, never in `landmarks.bin`.**
- **New `SURFACE` ids:** DIRT 14 (#a8754d), COURT 15 (#7d8c7a), TRACK 16 (#b5523b), POOL 17 (#6fa8c0, not water). Each needs `TERRAIN_SIDE_COLORS` and a topdown colour in `scripts/city/lib/topdown.mjs` (W1).
- **`decodeChunk`/`validateChunk`** check:
  - the exact byte length
  - frame == 0 (until c1), and reserved bytes == 0
  - cap ≤ 5, facade ≤ 5, accent and palette in range
  - every `parent` is 0 or an id in the same chunk table, or listed in `manifest.parents`
  - props inside the chunk, and `y1 > y0`
  - the `top` rules above.

**`landmarks.bin` (`SFL1`):**

- Global, loaded once, at most 200 KB.
- Header: magic, version, count.
- Boxes, 12 bytes each: `{x i16, z i16, y0 i16, y1 i16, sx u8, sz u8, color u8, flags u8}`.
- Holds the Bay Bridge west span, the Golden Gate south half to midspan, and Salesforce's open crown lattice. Sutro Tower is cut from v2 (§10).

**`landmask.bin` (`SFM1`):** header `{magic, version, cellsX u16, cellsZ u16}`, then one u8 per cell (§2).

**Manifest v2:**

- `proj` gains the five new keys (plus `frames` under c1).
- New fields: `areas`, `water`, `landmask`, `landmarks`, `walk`, `places`, `parents` (`{id: name}` for multi-entry landmarks).
- `budget.files` is 1300.
- `validateManifest` checks the fields above and rejects any extra keys.

**Walk graph `walk.bin` (`SFW1`; W5 writes it, W1 validates it).** It is binary, so the City DO wakes without a JSON parse:

```
header 32 B: magic, version u16, nodeCount u32, edgeCount u32, nameCount u32,
             builtAt (u64 ms), reserved
nodes:  Int32[nodeCount*3]  x10, z10, y10        (decimetre-blocks; y is walking surface)
edges:  Int32[edgeCount*5]  a, b, len10, nameIdx, halfWidth10 | deck<<31
names:  u32 offsets + utf8 blob
sites:  in places.json (node index per site)
```

- **y is always present.** For ground edges, it is ground at the node, and simplification keeps a node wherever the straight-line y would be off the real ground by more than 1 block. For deck edges (bridge ways under 300 m), it is the `report.json` deck top.
- Edges come from footway, pedestrian, living_street, residential, tertiary, secondary, primary, service (except parking aisles) and busway.
- No motorway, trunk or bridge decks, except bridge ways under 300 m.
- `validateWalk` checks:
  - magic and version
  - index ranges
  - that every edge appears in both directions
  - that `builtAt` equals `manifest.builtAt`
  - that every y is within [0, 300].

**`places.json`:** `{builtAt, places: [{id, kind: company|landmark|intersection|area, name, aliases[], lat, lon, x, z, node}]}`.

- Intersections are generated for every node where two distinct street names meet, keyed like "2nd St & Howard St". Both orders are aliases.
- Company places carry `siteId` and, for doors, `door: [x, z]`.

## 5. landmarks and structures (W3)

`scripts/city/sf/landmarks.json`. Each entry has:

- `key`: an OSM id or `lm:<slug>`
- `name`, `address`, `lat`, `lon`
- `heightRef`: a row key into `scripts/city/sf/skyline.src.json`, or for non-tower landmarks an explicit `realHeightM` with a `source` URL
- `palette` and `accent`
- `recipe`, a list of ops.

**Heights are generated, not typed.** `skyline.src.json` is a snapshot of the Wikipedia "List of tallest buildings in San Francisco" table: rank, name, lat, lon, roof m and spire m, with the page URL, revision id and access date. W3 commits it. `skyline.check` uses the same file.

- Recipe y-values are written as fractions of the reference height or as absolute blocks. A check asserts that the recipe's top equals `round(roofM / 3)` ±1 block, and the spire top equals `round(spireM / 3)` ±1 where the row has a spire.
- The "blocks" column in the table below is only a guide, recomputed from the snapshot at build time. Rows marked † were corrected in revision 2 and need a check against the snapshot.

**Recipe ops** are in blocks, relative to the max ground under the footprint:

- footprints: `rect`, `rrect{r}`, `circle{d}`, `poly`
- shaping: `tier{inset,y0,y1}`, `taper{from:[w,d],to:[w,d],y0,y1}`, `spire{w,y0,y1}`, `sawtooth{face,step,depth}`, `chamfer{corner,size}`
- `part{name, cap, facade, accent, accentFrom}`: starts a new building entry sharing the landmark's parent id. Ops after it write to that entry.
- `bowl{…}`: writes stand columns to the current entry.
- `field{poly, surface}`: clears `bldg` and `top` in the polygon and writes the surface layer through `setSurface`.
- `prop{…}`: chunk props.
- `mesh{…}`: written to `landmarks.bin`.

Orientation: `axisDeg` comes from the OSM polygon's long axis, so recipes stay right under any rotation or frame. Each footprint is pinned against its OSM polygon before commit and must match within ±2 blocks.

| # | landmark | blocks (guide) | recipe summary | colour |
|---|---|---|---|---|
| 1 | Salesforce Tower (37.7899, −122.3969) | 109 | rrect 17×17, chamfer 3; inset 1 at y35 and y70; body to y99; `accentFrom` 99 with crown to 109 (ring 107, core 109, cap=crown); open lattice in mesh | #dedcd4 / crown #f4f2ea |
| 2 | Transamerica (37.79517, −122.40279) | 87 | taper 18×18 → 6×6 over y0–65; spire 3×3 to y75, then 1×1 to y87; E/W wings 4×2 from y33 to y70 | #f2efe8 |
| 3 | 181 Fremont (37.7897, −122.39535) | 82 | 15×17 to y60; progressive corner chamfer to a skillion crown y68–72; mast prop 1×1 to y82 | #c8d0d6 |
| 4 | 555 California (37.7921, −122.40377) | 79 | 22×13, sawtooth long faces (step 2, depth 1); bank hall `part` to the east at 3 | #4e3530 |
| 5 | 345 California (37.7926, −122.40046) | 71 | podium 30×18 to y27; tower 16×10 to y64; 2 spire props 1×1 to y71 | #c9b9ad |
| 6 | Millennium Tower (37.79042, −122.39619) | 66 | rrect 17×17; insets at y58, 61, 64 | #8fa4b4 |
| 7 | The Avery (37.78776, −122.39456) | 63 | 13×13, 1-block step at the top | stone |
| 8 | Park Tower (37.79037, −122.39431) | 61 | 20×14, flat | stone |
| 9 | One Rincon Hill S (37.785766, −122.392162) | 65† | 14×14, perimeter frame 2 above the roof | #9fb3c2 |
| 10 | The Harrison (37.786417, −122.392044) | 41† | 12×12 | glass |
| 11 | 101 California (37.79286, −122.39796) | 61 | octagon d18; stepped glass base `part` 3 → 9 | stone/glass |
| 12 | 50 Fremont (37.790515, −122.397272) | 61 | 18×18, chamfer 2 | stone |
| 13 | 575 Market (37.78957, −122.40038) | 54† | 15×15 | #6b5e55 |
| 14 | Embarcadero Center 1–4 | EC1 57†, EC2 42†, EC3 42†, EC4 58† | slabs 8×28 along E–W, sawtooth both faces (step 2, depth 2); ends step down 3 tiers of 2; one `part` per tower | #ece8de |
| 15 | Ferry Building (37.79554, −122.3936) | 5 / 27 | shed `part` ~65×17 at 5 (facade arcade); clock tower `part` 6×6 to y15, 5×5 to 18, 4×4 to 21, 3×3 to 24 (cap dome); flagpole prop 1×1 to 27 | #f4efe2 |
| 16 | Coit Tower (37.80239, −122.40582) | 21 | circle d5, 1-block lip at the top | #e0e0e0 |
| 17 | Grace Cathedral (37.7919, −122.4134) | 8/17/20 | nave `part` 24×14 at 8; two 5×5 W-front tower `part`s at 17; flèche prop to 20 | #cfc8bb |
| 18 | Oracle Park (24 Willie Mays Plaza) | ≤11 | **ballpark** (below) | brick #8c4a3a, seats #2e5e4e |
| 19 | Chase Center (37.768, −122.3877) | 13 | **arena**: drum ~40×35, wall 10, dome top = base + 10 + round(3·(1−(r/R)²)); facade ribbed; 2-block glass band `part` at the street | #dcdcd8 |
| 20 | Bay Bridge west span | deck ~22 | mesh: towers at w432712476/77 as twin 2×3 legs to 53 with 3 cross-beams; double deck at 20/16; catenary cables as 1-voxel boxes; suspenders every 6 | #a7adb3 |
| 21 | Golden Gate Bridge (S tower 37.8113, −122.4777) | towers 76, deck 22 | mesh, south half to midspan; same recipe as 20 | #c0362c |
| 22 | Palace of Fine Arts (37.8029, −122.4484) | 16 | rotunda `part` circle d12, cap=dome, to y16; colonnade arc `part`, 2 wide at 6 | #d8c3a5 |

**Ballpark recipe (Oracle Park).** Detected as `building=stadium` or `leisure=stadium` with a baseball pitch inside.

- Home-plate direction: from the field centroid toward the infield centroid.
- `field` op over the field polygon: GRASS, with mow stripes from the viewer's tile shading. Infield: DIRT. A 1-block DIRT warning track runs inside the ring. The field clears `bldg`, so the field is ground, not roof.
- Stands (`part` "stands", `cap=seats`, `facade=4` brick arcade): height at distance d from the field ring is `min(Hmax, 1+floor(0.6·d))`.
  - `Hmax` = 10 within ±110° of home plate, falling to 3 in the outfield. That keeps the arcade low on the McCovey Cove side.
  - Per-column heights go in the `top` layer.
- Scoreboard: `part` slab 2×8 in centre field, facade 1.
- Light towers: 6 emissive chunk props, 1×1, up to Hmax+6.

**Structure classes** (`structureKind(osmTags, ds)` → recipe):

| class | recipe |
|---|---|
| arena | Chase Center recipe above |
| conference (Moscone) | facade=5; a `part` with cap=green where a park polygon overlaps (Yerba Buena Gardens) |
| pier_shed | gable heightmap along the long axis; #b9b3a8; facade=2; bulkhead +2 on the shore end |
| terminal_tower | DataSF max − median > 30 m with a landmark entry; never a centroid guess |
| church | nave plus tower 3×3 → 1×1 at the street end; height from DataSF max |
| parking_garage | #b5afa5, facade=3 |
| canopy (`building=roof`) | becomes a deck with corner pillars, not a building |
| transit_roofpark (Transbay) | top = street + 7; cap=green; facade=2 #f2f2ef |

## 6. Firegoat

- The source entry exists: `firegoat-501-2nd`, operator source, and it already ships in v1 `companies.json`. The Nominatim hint (37.7831785, −122.3929683) is not the anchor.
- v2 work:
  - The rebuild re-anchors it in the new coordinates.
  - `companies.check` asserts that the anchor equals the **SF EAS address point for 501 2nd St** (near 2nd & Bryant) within 1 block, and that the point lies on the DataSF footprint containing it. It also asserts `ship:true` and a visible label chip.
  - `walk.check` asserts its door reaches the Ferry Building node.
  - Firegoat is the first office↔site link (§7.3). The operator gives the office id, and the admin approval is one curl with `Authorization: Bearer` in the integration runbook.

## 7. characters in the city

### 7.1 Shape

- **One new tool on the existing office MCP.** Agents already connected to an office reach the city with no new MCP server, no extra configuration and no pass. A separate city MCP server, admin invites and open public join are **out of scope for v2**. They need their own auth design (v3).
- The Office DO is the only caller of the City DO's walker methods. It passes a verified agent identity over DO RPC. The City DO trusts only calls that come from an Office stub, and checks the link on every call.

### 7.2 Server: City Durable Object (W6)

- `src/city/do.ts`, class `City`. Binding `CITY`, migration `{tag:"v4", new_sqlite_classes:["City"]}`, one instance per city (`idFromName("sf")`).
- **Storage.** All durable state lives in DO SQLite and is written before any reply or broadcast. A hibernated or evicted DO restores from it. Memory holds only caches (the parsed graph, socket fan-out buffers).

  | table | columns | notes |
  |---|---|---|
  | `links` | officeId PK, siteId, state (pending\|approved\|rejected\|revoked), officeName, requestedAt, decidedAt | |
  | `walkers` | id PK (`<officeId>:<agentId>`), officeId, agentId, name, hue, siteId, path (JSON ≤64 pts), t0, speed, mode (walk\|ride), at (placeId or lat/lon JSON), inside, lastSeen, status | |
  | `presence` | officeId PK, siteId, agents (JSON), ts | TTL 3 min |
  | `chat` | seq PK, ts, fromWalker, scope (near\|city\|dm), to, text, x, z | 500-row ring; DMs never leave the DO except to sender and recipient |
  | `meta` | key PK, value | `builtAt`, `graphCheckedAt` |

- Public viewer sockets use the hibernation API (`acceptWebSocket`). Nothing about a socket is needed after a wake except its attachment.
- **Graph loading.** The DO loads `walk.bin` and `places.json` with `env.ASSETS.fetch`.
  - `walk.bin` is binary, so a cold wake does typed-array views with no parse. The expected cost is under 10 ms for about 600 KB, and W6 measures it.
  - The DO checks `manifest.json` `builtAt` at most once per 60 s, triggered by a request or the alarm (`meta.graphCheckedAt`). When it changes, it reloads and re-snaps (§7.7).
  - W6 proves on day 1, in `wrangler dev`, that ASSETS is reachable from the DO. If it is not, the fallback is a Data-module import of the two files.
- **Movement.** The server owns intent, not ticks.
  - `go` resolves a place (`places.ts`), runs A* (`route.ts`) and stores `{path, t0, speed, mode}`.
  - **Speeds:**
    - Trips up to 300 blocks use `walk` mode at 2 blocks/s, with a gait matched to speed.
    - Longer trips use `ride` mode at 8 blocks/s, drawn as a seated pose on an instanced scooter with no leg swing.
    - A city-wide trip of about 2500 blocks takes about 5 min.
    - `etaSec` is reported, never capped.
  - Position is `f(path, now−t0)`. y comes from the graph (§7.6).
  - **One alarm**, re-armed on every state change to the minimum of: the next arrival, the next walker away/removal deadline, the next presence expiry, the next broadcast flush, and the next graph check.
  - On arrival, the DO snaps `at` to the place and queues `arrive`.
  - The DO has no tick loop.
- **Walker lifecycle** mirrors the office (`AWAY_MS` 5 min, `REMOVE_MS` 1 h):
  - Every `office_city` call and every bridged presence push for that agent refreshes `lastSeen`.
  - After 5 min without one, the walker shows as away. After 1 h it is removed and `left` is broadcast.
  - `office_leave`, an office walk-out or invite revocation removes the walker immediately, through the bridge.
- **Broadcast batching.** `walk`, `arrive`, `presence` and `left` frames are coalesced per socket set and flushed at most once per second. `say` and public `chat` frames go out immediately; they are rate-limited at the source.

### 7.3 Tool: `office_city` (W6)

One tool is added to the office ToolSet in `src/tools.ts`. The office MCP lists 8 tools: the existing 7 unchanged, plus `office_city`. `buildServer`/`handleMcp` and the `ToolHost` interface are unchanged; the Office DO's `callTool` handles the new name and forwards to `env.CITY`.

| op | args | returns |
|---|---|---|
| `go` | `{to: place\|"2nd & Howard"\|agentName\|{lat,lon}\|"inside"\|"outside"}` | `{to:{kind,name,x,z}, distanceM, etaSec, mode, via:[street names], viewUrl:"/city/sf?follow=<walkerId>"}`. The first `go` places the walker at its site door, then routes |
| `look` | `{about?: here\|places\|agents}` | at here: your position, nearest place, moving/eta, agents within 40 blocks, places within 100 blocks, unread city chat count |
| `chat` | `{op: read\|send\|say\|wait, scope?: near\|city, to?}` | office semantics. near = 40 blocks from the sender's interpolated position, plus viewers. City scope is limited to 1 per 30 s per agent. DMs go by walker name and are private. Reuses waiter, pushChat and Webhooks |

- Join and leave are implicit. Status comes from the office status the bridge already carries, so there is no `city_status`.
- The tool is always listed. When the office has no approved link, every op fails with 403 `this office has no approved city link; the owner can request one with PUT /api/o/<office>/city`.
- **Who may walk:** agents joined with the owner key, plus agents from invites the owner has marked `city: true` (default false; set per invite in the owner UI or API). Other invitees get 403 `your invite isn't allowed in the city; ask the office owner`.
- **Fail loudly:**
  - an unknown or ambiguous place → 400 with the 5 closest candidates
  - no route → 400 `no walking route to <place>`
  - never a straight line through buildings.
- **Rate limits** use an in-DO token bucket per walker: `go` at 1 per 2 s and 20 per minute; `look` at 2 per s. A* is bounded at 20k node expansions and fails with 400 `route search too long` beyond that.
- **Caps:**
  - `MAX_CITY_AGENTS` is 300 city-wide and 20 walkers per office.
  - Viewers are capped at 500, with 503 when full.
  - Hitting a cap returns 429 or 503 with the cap in the message.
- **Names:**
  - The walker display name is the office agent name. City-wide uniqueness is enforced with the office's numbering rule ("claude@paw 2"), based on currently present walkers.
  - `?follow=` and the URL use the stable walker id. DMs by name resolve against present walkers and fail on ambiguity.
  - A name that, after normalisation, equals a company or place name other than the walker's own site is rejected with 400 `name looks like <company>; pick another`.
- Chat is untrusted text with the same SPOOF_* validation as the office.

### 7.4 Office ↔ company link and presence bridge (W6)

- **Link request.** The owner sends `PUT /api/o/:office/city {city:"sf", siteId}` with the owner key. The Office stores `{city, siteId}` and calls `city.requestLink(officeId, siteId, officeName)`. The link starts `pending`.
- **Spam limits:**
  - one pending or approved link per office (a new request replaces a pending one)
  - at most 5 pending requests per siteId and 200 pending city-wide; beyond that, 429 `too many pending link requests for <site>`
  - a per-IP `ratelimits` binding `CITY_LINK_LIMIT` (3 per 10 min), declared in `wrangler.jsonc`
  - `siteId` must exist in `companies.json` with `ship:true`.
- **Admin endpoints** use `Authorization: Bearer <ADMIN_KEY>` through the existing admin check in `src/api.ts`. No admin key ever goes in a query string.
  - `GET /api/city/sf/links?state=pending`
  - `POST /api/city/sf/links/:officeId/{approve|reject|revoke}`
- **Revocation.** Reject and revoke take effect on the next call. The City DO checks `links[officeId].state === "approved"` on every `office_city` call and every presence push. Revoke also removes that office's walkers and presence and broadcasts `left`.
- A pending link renders nothing.
- **Bridge.** On roster or status change, the Office debounces (at most 1 push per 5 s, plus a heartbeat on its existing alarm) and calls `city.officePresence(officeId, siteId, [{agentId, name, hue, status, out}])`.
  - Only name, hue and status cross the bridge: no activity text and no chat. The office id is a key inside the City DO and is never sent to viewers.
  - The City DO drops pushes from links that are not approved.
- **Inside/outside (de-dupe):**
  - A walker that calls `go inside` at its own site is hidden and counted as "in office".
  - While an office agent has a live walker, the bridge sends `out:true`. The city then draws the walker only, and the office viewer shows an "in the city" tag on the empty desk.
  - Visitor invites to other offices are deferred.
- **Public endpoints** (both registered in `worker.ts` before the ASSETS fallback):
  - `GET /api/city/sf` returns `[{companyId, agentCount, agents:[{name,hue,status}]}]` plus walkers `{id, name, hue, status, path, t0, speed, mode}`.
  - `WS /city/sf/ws` is view-only. It sends a snapshot `{now, walkers, presence, chatTail}`, then delta frames `walk | arrive | presence | say | left | chat`.
    - `chatTail` and `chat` frames carry **near and city scope only, never DMs**.
- `wrangler.jsonc` `run_worker_first` adds exclusions for `walk.bin`, `places.json`, `landmask.bin` and `landmarks.bin`.

### 7.5 Viewer (W7, on top of W4's scene API)

- **`live.js`:**
  - WS client, with the server clock offset taken from the snapshot `now`.
  - Path interpolation.
  - Right-hand sidewalk offset, using halfWidth from the graph.
  - **y from the graph (§7.6), never from `groundAt`.** That gives a correct y for walkers on decks and in unloaded chunks.
- **`walkers.js`:**
  - Bodies: one InstancedMesh, true-scale 0.6 block (v1 §1 rule kept). Leg/arm swing is done in the vertex shader, with frequency = speed / stride, so feet don't slide. Ride mode uses a seated pose and a scooter instance. One draw call for bodies, one for scooters.
  - Beyond camera distance 120: constant-pixel beacons (`THREE.Points`, `sizeAttenuation:false`, hue-coloured). One more draw call.
  - Nameplates and speech bubbles are DOM chips through `cullLabels`, ordered selected, talking, then nearest, with at most 24.
  - **All chat and names are set with `textContent` only.** URLs are shown as plain text and are never linkified.
- **`pins.js`** replaces `demoPresence` with the live feed. The `setPresence` contract stays the same. Building badges show "N here / M inside".
- **Follow:** `?follow=<walkerId>`; a people list in the panel; picking takes the screen-space nearest beacon within 12 px; a pan cancels follow.
- **Camera URL state:** `?cam=x,z,dist,az,polar`, used by the preview presets (§9).

### 7.6 Walk graph and places (W5)

- **Code:**
  - `scripts/city/walk-sf.mjs` and `scripts/city/lib/walk.mjs` read the cached roads and new footways, plus `report.json` `decks` for deck y and the manifest's ground through `groundAt`.
  - They snap each company door and landmark to the nearest edge, simplify with a y tolerance of 1 block, and write `walk.bin` and `places.json`.
  - `src/city/route.ts` is pure A* with an expansion bound, path simplification, and a `via` street list. Path points carry `[x, z, y]`.
  - `src/city/places.ts` is a pure resolver: normalisation, aliases, "&"/"and"/"at" intersections, and street-number addresses through the companies list. On ambiguity it throws with the candidates.
- **Walker y:**
  - Linear interpolation of node y along the current edge. Because simplification keeps nodes within 1 block of the true ground, walkers stand on ground or decks with at most 1 block of error.
  - If a path point lacks y, the viewer throws. It never falls back to 0.
- **Data:** `scripts/city/sf/places.src.json` lists these landmarks and areas as places: Ferry Building, Coit Tower, Oracle Park, Salesforce Tower, Transamerica, Pier 39, Palace of Fine Arts, Crissy Field, Fort Point, Presidio Main Post, Union Square, Chase Center, Moscone Center, Ghirardelli Square.

### 7.7 Rotation safety

- Durable state (links, walker `at`, places sources) is stored as `siteId`, `placeId` or `{lat,lon}`.
- When the DO's 60 s `builtAt` check (§7.2) sees a change, it reloads the graph and re-snaps every walker to its `at`, cancelling in-flight paths with `arrive`.
- Block coordinates are never persisted.

## 8. workstreams (strict file ownership; no file is owned by two workstreams at once)

**Order.**
- Day 0: the grid decision (§1.3).
- W1 lands first (~1 day).
- W2–W7 then run in parallel against the v2 fixture.
- Integration is §9.

**Stub handoff.** W1 creates stubs for files that W2, W3 and W5 then own. Ownership of each stub transfers when W1 merges. W1 never edits them afterwards. Requests to change W1-owned files (`city.js`, `topdown.mjs`, `package.json`, the `ctx`/raster API) go to W1 as an exact diff; W1 stays on call and applies them the same day.

**W1: contract and fixture (1 d; +0.5 d under c1)**

- **Files:**
  - `public/shared/city.js` (including `paletteFor` and `BUILDING_PALETTE`), `public/shared/city.d.ts`
  - `scripts/city/lib/topdown.mjs`
  - `package.json`: scripts. `city:build` = build-sf → companies-sf → walk-sf → verify-sf. Add `city:walk` too.
  - `scripts/city/fixture.mjs`, `public/city/fixture/**`
  - `scripts/city/check.mjs`, `scripts/city/checks/format.check.mjs`
  - stubs with final signatures, handed off at merge: `applyStructures`, `applyLandmarks`, `buildLandmarkMesh` (to W3), the raster API additions in `raster.mjs` (to W2), `buildWalk`, `route`, `resolvePlace` (to W5).
- **Delivers:**
  - everything in §4
  - the projection (`ROT_DEG` as one constant, or `frames` under c1)
  - the palette and `paletteFor` options from §3.9
  - the new SURFACE ids and their topdown colours
  - the frozen `ctx.osm` record shape (§3.3).
- The v2 fixture contains:
  - a taper tower using the `top` layer
  - a sawtooth slab
  - a two-`part` landmark sharing a parent, one part with `accentFrom`
  - a 3-block-high bowl with a `field` and props
  - a POOL above ground
  - a short bridge deck over water, with walk nodes at deck y
  - water, listed, unbuilt and sea chunks, with a `landmask.bin`
  - a 40-node `walk.bin` with 3 sites
  - a `landmarks.bin` with 50 boxes
- **Acceptance (`npm run check:city`):**
  - v2 encode/decode is byte-identical, including props, `top`, `parent` and `accentFrom`.
  - A v1 chunk throws with the version message.
  - Rotation roundtrip error is under 0.01 block for each of rotDeg 0, 9.2 and 44.7.
  - The rotated anchor table matches within 0.2 blocks with exact chunks.
  - `validateWalk` and `validateManifest` reject each mutated field (one case per rule).
  - The fixture is under 250 KB.
  - `npm run check` is green.

**W2: pipeline, extent, grid, data fixes (4 d; +3 d under c1)**

- **Files:**
  - `scripts/city/fetch-sf.mjs`, `build-sf.mjs`, `verify-sf.mjs`
  - `scripts/city/lib/{http,geo,raster,terrain,mask,osm,buildings,eas}.mjs`
  - new `scripts/city/lib/parts.mjs`
  - `scripts/city/sf/{config.mjs,overrides.json}`
  - `scripts/city/companies-sf.mjs`, `scripts/city/sf/companies.src.json`
  - `scripts/city/checks/{raster,geo,companies}.check.mjs`
  - generated: `public/city/sf/{manifest.json,chunks/*,companies.json,landmask.bin,report.json,LICENSE.txt}`
- **Day 2 deliverable to W3:** `scripts/city/.cache/sf-buildings.json`, the merged building records with full tags and structure kind (gitignored, shared by path), so W3 can develop on real data before W2 merges.
- **Acceptance** (on a build with W3's no-op hooks; real-hook gates are [post-int]):
  - `npm run city:build` stays within budget: ≤1300 files, ≤8 MB, ≤64 KB per chunk.
  - `verify-sf` passes the v1 points (recomputed) plus:
    - the 4 Presidio points from §2
    - the Civic Center station column is road/plaza
    - the 4th St bridge is a deck
    - the YBG fountain has ground > 0
    - Union Square is not PARKING
    - unbuilt-land skirts are under 2 blocks at the 90th percentile.
  - `report.json` contains `unresolvedTower: []` for the top-50 list and logs `droppedUnderground`, `deletedParcels`, `droppedFloatingParts` and `decks`.
  - `companies.check` passes, including Firegoat's anchor on the 501 2nd St EAS point (§6), and ILM shipped if its sources qualify.
  - Coverage of at least 90% DataSF area still holds.

**W3: landmarks, structures, mesh layer (4 d)**

- **Files:**
  - `scripts/city/lib/{structures,landmarks,meshlayer}.mjs`
  - `scripts/city/sf/{landmarks.json,skyline.src.json}`
  - `scripts/city/checks/{skyline,structures}.check.mjs`
  - generated: `public/city/sf/landmarks.bin`
- **Develops against** the fixture, the W1 raster API, and W2's day-2 `sf-buildings.json`. `structureKind` is unit-tested on hand-written tag records.
- **Acceptance on the fixture and unit level:**
  - `structureKind` classifies each structure class correctly.
  - Recipes produce valid chunks.
  - Every landmark entry has a `heightRef` or a `source` URL, and recipe tops match the snapshot.
  - `landmarks.bin` is under 200 KB, decodes, and every box lies inside the reserved grid.
- **Acceptance [post-int], on the real build:**
  - `skyline.check`: for all 50 rows of `skyline.src.json`, the tallest top within 6 blocks of the row's coordinate is within ±2 blocks (6 m) of the roof height. Spires count only where the recipe has one. v1 failed rows 9, 18, 28, 30, 34, 35, 39, 42 and 50; all of them must pass.
  - The 22 landmark footprints are within ±2 blocks of the OSM polygon extents.
  - Transamerica's top-width profile is monotonic non-increasing (width at y60 ≤ 8).
  - Ferry tower column top ≥ 24 while the shed is at 5±1, and both resolve to one parent on pick.
  - Coit footprint is at most 25 columns.
  - `structures.check`:
    - Oracle Park: field ≥ 60% GRASS/DIRT by area, with `bldg` 0 on the field; stand height rises with distance from the field; Hmax ≤ 11; outfield arc ≤ 3; exactly 6 emissive chunk props and no Oracle boxes in `landmarks.bin`; stands facade = 4.
    - Chase Center: dome profile.
    - No `building=stadium`, arena or conference structure uses facade 0.

**W4: viewer rendering (4 d; +3 d under c1)**

- **Files:**
  - `public/js/city/{loader,mesher,mesher.worker,scene,pick,labels,textures,stage}.js`
  - new `public/js/city/{meshlayer,unmapped,compass}.js`
  - `scripts/city/checks/{mesher,pick}.check.mjs`, `scripts/city/perf.mjs`
- **Delivers:**
  - the mesher reads per-column `top` and emits side faces where neighbour tops differ
  - the window atlas only when `facade==0`, with facade, cap and `accentFrom` shading
  - props, and the instanced `landmarks.bin` layer
  - sea, water-chunk, unbuilt (coarse relief from `landmask.bin`) and listed rendering, with edge skirts (§2)
  - the compass, rendered into `#city-compass` (a W7-provided container) when rotation ≠ 0
  - `scene.follow(getPos)/unfollow()` and a `setCamera({x,z,dist,az,polar})` API for W7
  - `pick` resolving to `parent || id`.
- **Acceptance:**
  - `mesher.check`: on the fixture, the taper and bowl produce the expected face counts; the facade-1 building gets no window UVs; the accent band starts at `accentFrom`.
  - `pick.check`: picking a stand column returns the ballpark parent id; picking a prop returns its building; picking the Ferry tower and the shed return the same parent.
  - `perf.mjs` at spawn and at the Presidio overview: ≤1.5M triangles after culling, ≤90 draw calls.
  - Headless render (§9): no console errors, and the unbuilt-land pixel colour differs from the sea colour.
  - `npm run check:viewer` is green.

**W5: walk graph and places (2.5 d)**

- **Files:**
  - `scripts/city/walk-sf.mjs`, `scripts/city/lib/walk.mjs`
  - `scripts/city/sf/places.src.json`
  - `src/city/route.ts`, `src/city/places.ts`
  - `scripts/city/checks/{walk,places}.check.mjs`, `test/city-route.test.ts`
  - generated: `public/city/sf/{walk.bin,places.json}`
- **Develops against** the fixture `walk.bin` and v1 cached roads; real-build gates are [post-int].
- **Acceptance:**
  - `walk.check` [post-int]:
    - the largest component holds ≥95% of nodes
    - every shipped site door and every place reaches the Ferry Building node
    - `walk.bin` is ≤600 KB raw and ≤150 KB gzipped
    - `builtAt` matches the manifest
    - nodes on 4th St bridge edges have y equal to the deck top ±0.5
    - every ground node is within 1 block of `groundAt`.
  - `places.check`: these resolve uniquely:
    - "Firegoat"
    - "501 2nd St"
    - "2nd & Howard"
    - "howard and 2nd"
    - "Ferry Building"
    - "Oracle Park"
    - "Palace of Fine Arts"
  - Ambiguous "Market" throws with at least 2 candidates.
  - `vitest`:
    - the Firegoat → Ferry Building route has `via` including "2nd St", and its distance is 1.0–1.6× the straight line
    - an unreachable target throws
    - a search over the expansion bound throws `route search too long`.

**W6: City server and office bridge (4 d)**

- **Files:**
  - `src/city/{do,walkers}.ts`
  - `src/office.ts`, `src/tools.ts`, `src/api.ts`, `src/worker.ts`
  - `wrangler.jsonc` (binding `CITY`, migration v4, `CITY_LINK_LIMIT`, `run_worker_first`)
  - `vitest.config.ts`, `worker-configuration.d.ts` (regenerated with `wrangler types`)
  - `test/city-*.test.ts` (except `city-route.test.ts`)
  - `src/mcp.ts` is untouched.
- **Acceptance (vitest with the miniflare DO harness already in `test/helpers.ts`):**
  - Tools: the office MCP lists the 7 existing tools byte-identical to a snapshot, plus `office_city`.
  - Link flow:
    - pending → the push is ignored and `office_city` returns 403
    - after approve, `GET /api/city/sf` shows Firegoat's agents
    - the bridged and public payloads contain no activity text and no office id (deep key scan)
    - after revoke, the next `office_city` call returns 403 and the walkers are gone.
  - Spam: a 6th pending request for one site returns 429; the admin routes reject a `?key=` query and accept only Bearer.
  - Access: an invite without `city:true` gets 403; the owner-key agent and a `city:true` invitee can walk.
  - Movement:
    - `go "2nd & Howard"` from the Firegoat door returns `mode:"walk"` and `etaSec` equal to path length / 2 ±1 s
    - a trip over 300 blocks returns `mode:"ride"`
    - the position at t0 + eta/2 lies on the path, with y from the graph
    - the alarm emits `arrive` and re-arms to the next earliest deadline (two staggered walkers arrive in order).
  - Lifecycle: with no calls for 5 min the walker is away; at 1 h it is removed with `left`; `office_leave` removes it at once.
  - Persistence: after a forced DO eviction (harness restart), walkers, links and the chat ring are restored from SQLite.
  - Limits: a second `go` within 2 s returns 429; the 21st walker of one office and the 301st city-wide are refused.
  - Names: a duplicate name gets a number; a name equal to another company's name returns 400.
  - Chat:
    - near chat reaches an agent 30 blocks away but not one 60 blocks away
    - city scope is rate-limited
    - a DM never appears in the WS `chatTail` or in `chat` frames.
  - De-dupe: an office agent with a live walker is bridged with `out:true`.
  - Broadcast: 50 presence pushes within 1 s produce at most 1 `presence` frame per socket.
  - A `builtAt` change, seen by the 60 s check, re-snaps walkers.
  - `npm run typecheck` and `npm test` are green.
  - `wrangler dev` proves ASSETS is reachable from the DO, and the cold-wake `walk.bin` load measures under 10 ms.

**W7: viewer characters and UI (3 d)**

- **Files:**
  - `public/js/city/{pins,panel,ui,search,app,banner}.js`
  - new `public/js/city/{live,walkers}.js`
  - `public/index.html` (city page DOM and CSS: `#city-compass` container, people list, panel)
  - `scripts/city/checks/ui.check.mjs`
- **Delivers:** §7.5, `?follow` and `?cam` URL state, the people list, the "who's here" panel, and search over places and agents.
- **Acceptance:**
  - `ui.check` against a mock WS feed:
    - the snapshot plus 3 walk frames give interpolated positions (x, z and y) within 0.1 block of the expected values at 3 timestamps, including one on a deck
    - a path point without y throws
    - beacon mode switches at distance 120
    - at most 24 DOM chips
    - a chat containing `<b>` and a URL renders as literal text with no `<a>`
    - follow keeps the target within 1 block over a 10 s simulated walk
    - `setPresence` with Firegoat shows the badge "2 here".
  - No `demoPresence` reference remains (rg check).

**Integrator (§9):** owns the integration branch, the scratchpad seed script, and `docs/city/spec.md`, which is updated after merge to record what shipped.

## 9. integration and preview

1. **Merge order** (acyclic):
   - W1, then W2 (with W3's no-op stubs), then W3, then W5, then W4, then W7, then W6.
   - W2 never imports W3 code directly; it calls the W1-frozen hook signatures.
   - W3's and W5's real-build gates run after W2 merges.
   - One integration branch; each workstream works in its own worktree.
2. **One rebuild:**
   - `npm run city:fetch` (new queries, west area, z12 coarse terrain; the Overpass cooldown is respected)
   - then `npm run city:build` (build → companies → walk → verify)
   - then `npm run check`.
   - Gates marked [post-int] (skyline, structures, walk, places, perf, verify-sf) all run on the real build.
3. **Preview:**
   - Local `npm run dev` (wrangler dev :8799).
   - A seed script, kept in the scratchpad (not committed), does the following:
     - creates an office and links it to `firegoat-501-2nd`
     - approves the link with a Bearer admin curl
     - joins 3 agents through the office MCP: 2 stay in the office, and 1 calls `office_city go "Ferry Building"`
     - sends one near chat.
   - Headless screenshots use Playwright's bundled Chromium (never system Chrome) at 1280×800 and 390×844, for these `?cam=` presets:
     - `bay`: from Treasure Island toward the FiDi/Transbay skyline
     - `nobhill`: from Nob Hill looking NE over FiDi
     - `oracle`: close, from the cove
     - `firegoat`: close, following the walker
     - `presidio`: overview with the GGB
     - `ferry`: clock tower, close
   - The integrator puts each preset next to a reference skyline photo (link only) in the hand-off.
   - Gate: no console errors on any preset.
4. **Operator sign-off on the preview:** the skyline match, the stadium, the Presidio, and Firegoat with characters at its building. The grid option was already fixed on day 0 and is not reopened here.
5. **Deploy is operator-only** (never `cf deploy` from an agent), on the "Aleks Personal" account:
   - apply migration v4 (`City`) with the `CITY_LINK_LIMIT` ratelimit binding
   - after deploy, approve Firegoat's link with one Bearer admin curl.
   - Every chunk path changes version, so the CDN and browser caches are invalidated by the manifest `builtAt` query string.

## 10. risks and cut-lines

- **OSM part quality.** Some parts have levels but no height. §3.4 rule 5 covers it (4 m per level for office parts with ≥10 levels), and the landmark recipe wins for the top 22. Anything left unresolved goes to the report and gates the build.
- **Floating parts.** Skybridges and overhangs are dropped (§3.5). If the skyline check fails because of a dropped part, the fix is a landmark `mesh` op, not a format change.
- **Projection change.** Anything external that holds v1 block coordinates breaks. Nothing persisted outside the repo does today.
- **Grid choice.** If the operator picks c1 and time runs over, the fallback is option a with `frame` reserved. That fallback does not re-plan W5–W7.
- **Budget.** If LOD2 goes over the triangle gate with ~980 chunks, the cut is to downsample Presidio LOD2 ×8.
- **Single city DO.** All walkers and viewers share one DO. The caps, batching and A* bound in §7.2–7.3 are the mitigation. If load tests exceed 50% CPU at 300 walkers, viewer fan-out moves to a sharded broadcast DO (v3).
- **Cut from v2 already:**
  - Sutro Tower: it lies outside both areas.
  - The separate city MCP server, city passes, admin invites and open public join: these need a v3 auth design.
- **Cut order if time runs short:**
  1. churches class
  2. canopies
  3. the people list in the follow UI
  4. ride-mode scooter mesh (ride uses the walk pose without swing)
  5. inside/outside (but `out:true` de-dupe ships whenever `office_city` ships)
  6. city-scope chat.
- **Never cut:** format v2 + skyline check, the Oracle Park recipe, the Presidio extent, the presence bridge with Firegoat, `office_city go/look`.