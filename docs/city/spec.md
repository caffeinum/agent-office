# sf voxel city: build spec v1.1

This revision addresses all 16 review items. The repo was not touched. Coordinates in this spec were computed from the projection constants below. Items marked "W2 pins" or "W3 pins" are values the owning workstream must look up and commit before coding against them.

> **Operator decisions (made by agent-office on the operator's behalf, 2026-10-31; the operator asked us to "decide on exact scale"):** 1 block = 3 m horizontal and vertical, 1:1 elevation, no tower compression; lots 2–3 blocks wide, residential roadway 4 blocks + 1-block sidewalks (matches "buildings 2-3-5 blocks, roads 4-5 blocks" as widths); staircase grids accepted as Minecraft style; 1 office cell = 1/4 block. Section 0 sign-off is therefore DONE — W2 does not wait.

## 0. operator decisions needed before W2 starts

The operator confirms these on the fixture (`/city/fixture`) at the end of W1. W2 does not start its real build until they are signed off.

1. **Scale.** The request was "buildings 2–5 blocks wide, roads 4–5 blocks". At 3 m per block:
   - SF lot widths match: a 25 ft lot is 2–3 blocks.
   - Downtown footprints come out 10–30 blocks wide.
   - Towers come out about 109 blocks tall.
   - If the operator meant buildings should be 2–5 blocks *tall*, that conflicts with real 1:1 elevation and `TOWER_KNEE` off. The operator has to choose one.
2. **Staircases.** At 3 m, the rotated SoMa and Mission grids render as staircases. Accepted as Minecraft style, subject to confirmation.
3. **Office-to-city scale (section 1).** The operator confirms 1 office cell = 1/4 block.

## 1. scale, area, dimensions

- **1 block = 3 m horizontally and 3 m vertically.** One block is one world unit, and one storey is about one block.
  - a 25 ft lot is 2–3 blocks wide.
  - a residential roadway is 4 blocks, with a 1-block sidewalk on each side.
  - Market St has a 7-block roadway and 2-block sidewalks.
  - a Victorian is 3–4 blocks tall.
- **Vertical is linear 1:1 with no tower compression.**
  - Salesforce Tower is about 109 blocks, Transamerica about 87, Nob Hill ground about 34, Telegraph Hill about 28.
  - `TOWER_KNEE` exists in config but stays off.
- **Office-to-city scale.**
  - In the office, 1 cell = 1 office world unit (`public/shared/catalog.js`), and a desk is about 2 cells.
  - Rule: **1 office cell = 1/4 block = 0.75 m.** A desk is therefore about 0.5 block (1.5 m), which is less than one block. A person is about 0.6 block (1.8 m).
  - Exported as `OFFICE_CELL_BLOCKS = 0.25` in `public/shared/city.js`.
  - v1 never renders an office inside the city. Clicking a building never opens `/o/:id` in v1. In phase 2, the panel may show an "open office" link to `/o/:id` only for offices that opted in through the presence API. It is a plain navigation, not an in-city render.
  - Anything agent-sized drawn in the city (the pins) follows this scale: no city figure is 1 block tall or taller.
- **Rounding rules:**
  - `ground = max(1, round(elev_m/3))` on any column the land/water mask (section 2) marks as land. Land is never below y=1. Water top is y=0.
  - buildings: see the building rules in section 2.
- **Projection.** It is global and fixed, so chunk coordinates stay the same when the map grows to the whole city.
  - local equirectangular: `lon0=-122.5200`, `lat0=37.8350` (the NW corner), `latRef=37.77`, `mPerDegLat=110574`, `mPerDegLon=111320·cos(latRef)=87995.8`.
  - `x = (lon-lon0)·mPerDegLon/3`, `z = (lat0-lat)·mPerDegLat/3`. +x points east, +z points south, y points up, y=0 is sea level.
  - extent: the city's east edge (lon −122.3569) computes to x ≈ 4784, and the south edge to z ≈ 4681.
  - the reserved grid is 0..4842 × 0..4681 blocks (76×74 chunks). The extra ~58 blocks on x are deliberate margin.
- **Chunk:** 64×64 columns (192 m).
- **v1 area (downtown, SoMa, FiDi, North Beach, Telegraph Hill, Nob Hill, Mission Bay, Dogpatch edge, Ghirardelli edge):**
  - chunks cx 42..62 and cz 14..46, which is 21×33 = 693 chunks.
  - blocks x 2688..4031 and z 896..2943 (1344×2048 blocks, 4.0×6.1 km).
  - bbox lon −122.42836..−122.38254, lat 37.75513..37.81069.
  - the Marina (x ≈ 2620–2680, chunk 41) is **outside** v1 and is not claimed.
  - this holds about 90% of the scouted companies.
- **Sanity anchors.** Every row is asserted in `format.check.mjs` with a tolerance of 0.2 blocks, and the chunk must match exactly.

  | place | lat | lon | x | z | chunk |
  |---|---|---|---|---|---|
  | Salesforce Tower | 37.7897744 | −122.3969321 | 3609.8 | 1666.9 | 56,26 |
  | Ferry Building | 37.7955 | −122.3937 | 3704.6 | 1455.9 | 57,22 |
  | Transamerica | 37.7952 | −122.4028 | 3437.7 | 1466.9 | 53,22 |
  | Grace Cathedral | 37.7919 | −122.4134 | 3126.8 | 1588.6 | 48,24 |
  | Coit Tower | 37.8024 | −122.4058 | 3349.7 | 1201.6 | 52,18 |
  | Pier 39 | 37.8087 | −122.4098 | 3232.4 | 969.4 | 50,15 |
  | Ghirardelli | 37.8059 | −122.4229 | 2848.1 | 1072.6 | 44,16 |
  | OpenAI, 1455 3rd St (EAS 489890) | 37.770061 | −122.3887726 | 3849.2 | 2393.5 | 60,37 |

  - The OpenAI row is the EAS point for 1455 03RD ST (eas_baseid 489890, parcel 8721033), set by W3 together with the check.
- **Default spawn:** target 3610,1667, distance 600, day theme.

## 2. data pipeline

**Dependencies:** `pngjs@7.0.0` (devDep, added by W1) only. Node's built-in zlib does the gzip. Hand-written geometry in `lib/geo.mjs`:

- polygon scanline
- line stamping
- point-in-polygon
- **ring assembly**: stitches loose member ways from `out geom` relations into closed outer and inner rings by matching endpoints.
  - unclosable rings go to the report.
  - the build fails if more than 1% of relations are unclosable.
  - covered by `scripts/city/checks/geo.check.mjs` (W2), with these cases: two-way outer, outer with an inner hole, reversed member, unclosable.

No GDAL.

**Raw cache:** `data/city/sf/raw/` (gitignored as `/data/`).

- Each fetch records `{id,url,license,fetchedAt,bytes,sha256}` in `raw/sources.json`.
- Every request sends User-Agent `agent-office-city-build/0.1 (+https://github.com/caffeinum/agent-office)` and retries 5× with exponential backoff.
- **Content types:**
  - accepted: `application/json`, `application/*+json` (DataSF `.geojson` replies `application/vnd.geo+json`), and `image/png`.
  - anything else, including HTML or XML, fails the fetch, and the first 200 bytes go in the error.
- **Overpass etiquette:**
  - the first fetch runs each query once.
  - `--force` refuses to re-hit Overpass when the cached response is less than 24 h old.
  - rebuilds always run from the cache.

**Sources and endpoints:**

1. **DataSF Building Footprints** (ynuv-fyni, PDDL)
   - endpoint: `https://data.sf.gov/resource/ynuv-fyni.geojson?$select=area_id,mblr,hgt_median_m,hgt_maxcm,gnd_min_m,peak_1st_m,shape&$where=within_box(shape,37.8157,-122.4340,37.7501,-122.3769)&$limit=200000` (bbox plus 500 m margin).
   - use data.sf.gov, never data.sfgov.org: the old host answers with a meta-refresh page, not a redirect.
   - if `within_box` is rejected, download the whole dataset and stream-parse it.
2. **OSM via Overpass** (`https://overpass-api.de/api/interpreter`, ODbL), using bbox `(37.7501,-122.4340,37.8157,-122.3769)`.
   - every query is prefixed with `[out:json][timeout:300][maxsize:1073741824];`.
   - three queries:
     - roads: `way["highway"](bbox);out geom tags;`
     - land: one union query, for both ways and multipolygon relations, with `out geom tags;`. It covers:
       - `leisure~park|garden|pitch|golf_course`
       - `landuse~grass|forest|cemetery|recreation_ground|railway`
       - `natural~wood|water|sand|beach|scrub|grassland`
       - `man_made=pier`, `railway~rail|light_rail`, `amenity=parking`, and `highway=pedestrian+area=yes`
     - buildings: `wr["building"](bbox);out geom tags;`
   - `natural=coastline` is not in the land query. It is fetched only if the fallback in source 5 is needed.
   - fallback if Overpass stays down: a BBBike or Geofabrik `.osm.pbf` extract. That needs a pbf reader dependency, which is a W1 decision made only if the fallback is triggered.
3. **Terrain:** AWS Terrarium z15 tiles, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/{x}/{y}.png`, decoded as `R*256+G+B/256-32768`.
   - cached under `raw/terrarium/15/`.
   - used **only for land height**, never to decide land vs water.
   - the joerd attribution text (`https://github.com/tilezen/joerd/blob/master/docs/attribution.md`) is fetched and stored verbatim in `sources.json` under the terrain entry.
4. **Addresses:** DataSF EAS (3mea-di5p, PDDL), queried per company address. Owned by W3 (section 4).
5. **Land/water mask** (W2):
   - **primary:** a DataSF PDDL shoreline or land polygon. W2 identifies the dataset on data.sf.gov, pins its id and URL in `config.mjs` before coding the mask, and records it in `sources.json`.
   - **fallback**, if no usable DataSF polygon exists: Overpass `way["natural"="coastline"](bbox)`, assembled with the ring assembler. Open ends are closed along the bbox edge with the sea on the right of the way direction (the OSM convention).
   - the mask is rasterised at block-centre resolution.

**Build rules** (`build-sf.mjs`):

- **Terrain and water:**
  - a column is WATER (ground 0) iff the mask says water. Bathymetry is discarded.
  - a land column gets `ground = max(1, round(bilinear_elev_m/3))`, so seawall and fill areas (Embarcadero, Mission Bay, McCovey Cove edges) never drop below 1.
  - water within 2 blocks of land becomes SHALLOW.
  - OSM `man_made=pier` polygons force ground 1 and surface PIER, even over mask water.
  - any building column whose footprint lies on mask water (Ferry Building, Piers 1–45 sheds) also gets ground 1 and surface PIER under the building.
  - land with no other class: HILL if `ground ≥ 20` (60 m), else GRASS.
- **OSM landcover → SURFACE:**

  | tag | SURFACE |
  |---|---|
  | `leisure=park\|garden`, `landuse=recreation_ground` | PARK |
  | `leisure=pitch\|golf_course`, `landuse=grass`, `natural=grassland` | GRASS |
  | `landuse=forest`, `natural=wood\|scrub` | FOREST |
  | `landuse=cemetery` | PARK |
  | `natural=sand\|beach` | SAND |
  | `natural=water` (inland) | WATER (ground 0) |
  | `landuse=railway` | RAIL |
  | `amenity=parking` | PARKING |
  | `highway=pedestrian + area=yes` | PLAZA |
  | `man_made=pier` | PIER |

  - tags not in the table are ignored and counted in the report.
- **Stamp order** (later layers overwrite earlier ones): mask → landcover polygons → sidewalks → roads → rail → buildings.
- **Highway filter.** Drop ways with any of:
  - `highway` = proposed, construction, abandoned, corridor, platform, elevator, or bus_stop
  - any `indoor=*` tag
  - `layer<0`
  - `tunnel=yes`
  - `area=yes`, except `highway=pedestrian`
  - `footway=sidewalk|crossing`. Sidewalks come from road classes (+sw) only, so streets never get doubled sidewalks.
- **Road widths, roadway in blocks** (sidewalk 1 block per side where marked +sw):

  | highway | roadway | sidewalk |
  |---|---|---|
  | motorway | 7 | none |
  | trunk | 6 | +sw |
  | primary | 6 | +sw |
  | secondary | 5 | +sw |
  | tertiary, residential, unclassified | 4 | +sw |
  | living_street | 3 | +sw |
  | service | 2 | none |
  | pedestrian | 3 | becomes PLAZA |
  | footway, path, cycleway, steps | 1 | becomes SIDEWALK |

  - name overrides: Market St roadway 7 with sidewalk 2, Van Ness Ave roadway 8.
  - an OSM `width` tag wins: `max(1, round(width/3))`.
  - `*_link` takes its parent class width minus 2, with a minimum of 2.
  - Rail is 2 blocks wide. Muni tram lines are skipped (they become markings in v2).
- **Bridges and decks:** applies to `bridge=yes` or `layer≥1` on motorway, trunk, primary and their `*_link`.
  - skip in v1 any such way where more than 50% of its centreline columns are mask water. That covers the Bay Bridge spans, which are a phase-2 landmark. The skipped length goes in the report.
  - `deckY = (max ground within 3 blocks of the centreline) + 1 + 2·max(1, layer)`. So layer 1 is +3 (about 9 m) and layer 2 is +5 (about 15 m).
  - `overrides.json` may pin `deckY` per way (`o:w<id>` → `{deckY}`). It is used for I-80 and the 101 SoMa viaducts, which run at about 15–25 m. W2 sets these overrides for the elevated freeway ways inside the bbox.
  - drawn as a 1-block slab, with a 1×1 pillar every 12 blocks along the centreline.
  - where ramps are stacked, a column keeps only the highest deck. This is accepted in v1 and counted in the report.
  - the ground keeps its own class.
- **Buildings:**
  1. the base set is the DataSF footprints, using `h = hgt_median_m`.
  2. an OSM building with `height` or `building:levels` (levels × 3.5 m) is matched to DataSF footprints where either centroid sits inside the other polygon.
     - **height:** if the OSM height is more than the DataSF height + 6 m, take the OSM height.
     - **footprint:** if the OSM area is more than 1.5× the matched area **and** (the OSM height is over 60 m **or** the OSM id has an override), replace the matched footprints with the OSM polygon. This covers post-2010 towers.
     - in all other cases the DataSF footprints keep their own per-parcel heights.
  3. OSM buildings with no DataSF match are added (height tag, else levels × 3.5, else 9 m).
  4. `scripts/city/sf/overrides.json` is applied last. It is keyed `d:<area_id>` / `o:w<id>` / `o:r<id>` and maps to `{heightM?, palette?, deckY?}`.
  - **base and top:**
    - `base` = the minimum ground under the footprint.
    - `top = (max ground under footprint) + max(1, round(h/3))`.
    - the roof is therefore never below the uphill terrain. Columns are filled down to `base`, which gives Minecraft terraces.
    - `peak_1st_m` is selected for the report only: it lists buildings where `|DataSF peak − top·3| > 9 m`.
  - a building owns the columns whose centres fall inside its polygon. A sub-column building takes its centroid column. Where buildings overlap, the taller one wins.
  - heights are parsed as m or ft. Unparseable tags go to the report and are ignored. The build fails if more than 2% of tagged buildings are unparseable.
  - `roof`: 0 = flat is the only value in v1. Other values are reserved for phase-2 landmark kinds.
- **Palette:** by height in blocks (`top − base`).
  - ≤4: pastel
  - 5–12: midrise brick or stucco
  - 13–30: stone or concrete
  - >30: glass
  - the variant within a group is `hash(id)`. Landmarks are set by override.
- **Building ids:** u32, assigned sequentially after sorting by source key. They are stable only within one build, which is fine because companies are re-placed on every build.

**Output** (committed and served as static ASSETS; no Worker change):

- **`public/city/sf/manifest.json`**:
  `{version:1, city:"sf", name, blockM:3, chunk:64, proj:{lon0,lat0,latRef,mPerDegLat,mPerDegLon}, chunks:{min:[42,14], max:[62,46], list:[[cx,cz,bytesGz],...]}, yRange:[min,max], spawn:{x,z,dist}, attribution:[...], sources:[...], builtAt}`.
  - a chunk inside min/max that is missing from `list` is open water: the viewer draws a water plane.
  - all-water chunks are not written.
- **`public/city/sf/chunks/{cx}_{cz}.bin`** is a gzip stream inside a file named `.bin`, so Cloudflare serves it as `application/octet-stream` with no Content-Encoding.
  - the client checks the gzip magic `1f 8b` and throws `"not a city chunk (got HTML?)"` when the first byte is `<`. That guards against the SPA fallback.
  - after gunzip, little-endian:

    | field | type | bytes |
    |---|---|---|
    | header: magic | `"SFC1"` | 4 |
    | header: version | u16 = 1 | 2 |
    | header: cx | i16 | 2 |
    | header: cz | i16 | 2 |
    | header: size | u16 = 64 | 2 |
    | header: nBuildings | u16 | 2 |
    | header: reserved | u16 | 2 |
    | ground | Int16[4096] | 8192 |
    | surface | Uint8[4096] | 4096 |
    | bldg | Uint16[4096] (0 = none, else table index + 1) | 8192 |
    | deck | Int16[4096] | 8192 |
    | building table | nBuildings × 12 | 12 each |

  - `deck` values:
    - `0` = no deck.
    - `> 0` = deck slab with its top at that y.
    - `< 0` = deck slab with its top at `−deck`, **plus a pillar** from ground up to the slab.
  - each table entry is `{u32 id, i16 base, i16 top, u8 palette, u8 roof, u16 reserved}`.
  - column index is `lz*64+lx`. For a building column, `ground` holds its base.
- **`public/city/sf/companies.json`** (W3, see section 4).
- **`public/city/sf/LICENSE.txt`**:
  - the data files under `public/city/**` (manifest, chunks, companies.json) are derived from OSM and released under ODbL 1.0.
  - the rest of the repo, including the build scripts, stays MIT.
  - `scripts/city/` together with `raw/sources.json` is the "means to reproduce" the derived database.
  - it includes the full attribution string and the joerd source list.
- **Build artefacts** (gitignored) in `data/city/sf/build/`:
  - `report.json`, holding:
    - counts and warnings
    - total output bytes and the per-chunk byte maximum
    - all-water chunk count
    - unclosable rings, unmapped landcover tags, skipped bridge length and stacked-deck columns
    - the `peak_1st_m` disagreement list
    - footprint area coverage
  - `topdown.png`: a 1 px-per-column preview of surface colours with buildings shaded by height, readable headless.

**Size budget:**

- ≤64 KB per chunk (the build fails above it).
- ≤8 MB total for `public/city/sf/`.
- ≤700 files: 693 chunks maximum, plus manifest, companies and LICENSE.
- manifest ≤100 KB.
- companies.json ≤50 KB.
- build ≤3 min and ≤4 GB heap.

**Attribution** (stored in `manifest.attribution` and always shown in the viewer):

> Map data © OpenStreetMap contributors, ODbL — openstreetmap.org/copyright · Building footprints & addresses: DataSF, City and County of San Francisco (PDDL) · Elevation: Terrain Tiles on AWS Open Data (Mapzen/Tilezen; sources incl. USGS 3DEP, NOAA — github.com/tilezen/joerd/blob/master/docs/attribution.md) · Company locations: public sources listed per entry.

**npm scripts** (all added by W1; W1 owns `package.json`):

- `city:fixture` = `node scripts/city/fixture.mjs`
- `city:fetch` = `node scripts/city/fetch-sf.mjs`
- `city:build` = `node --max-old-space-size=4096 scripts/city/build-sf.mjs && node scripts/city/companies-sf.mjs && node scripts/city/verify-sf.mjs`
- `check:city` = `node scripts/city/check.mjs`, which runs every file in `scripts/city/checks/*.check.mjs`. This is deterministic only, with no timing gates.
- `city:perf` = `node scripts/city/perf.mjs`. It reports mesher timings and is **not** part of `check`.
- `check:city` is appended to `check`.

## 3. viewer

- **Route:** in `public/js/app.js` `boot()`, the first statement matches `/^\/city\/([a-z0-9-]+)\/?$/`. On a match it hides `#app` and `#landing`, runs `import("./city/app.js").then(m => m.bootCity(id))`, and returns.
  - this runs before any use of the module-scope office `demo` flag (`app.js` line 15, used from line 54 on), so office demo logic never runs on `/city/*`.
  - the city does not read `demo` at all. Its demo flag is `?pins=demo` (see URL state).
  - the Worker needs no change: the SPA fallback already serves index.html.
  - `/city/fixture` serves the synthetic test city.
- **Do not refactor `scene.js`.** The city gets its own `public/js/city/stage.js`, about 200 duplicated lines covering:
  - renderer: WebGL2, DPR cap 1.25, adaptive down to 1.0 when fps < 45.
  - composer and bloom.
  - hemi light and sun.
  - day/night THEMES.
  - sky and fog.
  - OrbitControls in map style.
  - WASD.
  - touch.
  - rAF loop.
  - extracting a shared stage out of the office scene is phase-2 debt.
- **Input:**
  - desktop: WASD plus mouse.
  - touch:
    - one-finger drag pans.
    - pinch zooms.
    - two-finger twist rotates and two-finger vertical drag tilts.
    - tap picks.
  - UI stays usable at 390×844 with no horizontal page scroll.
- **Modules:**
  - `public/js/city/`: app.js, stage.js, scene.js, loader.js, mesher.js, mesher.worker.js, pick.js, textures.js, ui.js, labels.js, panel.js, search.js, pins.js.
  - `public/css/city.css` is injected by app.js, so `index.html` is not edited.
  - `mesher.js` and `mesher.worker.js` must import only `../../shared/city.js` by relative path, because module workers do not get the importmap. No `three` in the worker.
- **Loading:**
  - `loader.js` fetches the manifest, then fetches chunks nearest-first with 6 in flight.
  - it inflates with `DecompressionStream('gzip')`, decodes with `decodeChunk`, and keeps every decoded chunk in a store (v1 total is about 20 MB decoded).
  - a missing listed file, a bad magic number or a version mismatch shows a red error banner and throws. Errors are never swallowed.
- **Meshing** (worker is stateless):
  - requests from main:
    - `{id, kind:"chunk", lod:0, chunk, n, s, e, w}` for an LOD0 chunk.
    - `{id, kind:"region", lod:1|2, chunks:[...16 or fewer], skip:[[cx,cz],...]}` for a region.
    - decoded typed arrays are passed, with neighbours null when absent.
  - the reply is `{id, opaque, walls?}` buffers as transferables, or `{id, error}`.
  - a chunk is meshed only once all four neighbours are loaded or known to be absent.
  - **greedy heightfield meshing:**
    - top faces are merged by (y, colour).
    - side faces are emitted only where the neighbour column is lower, as one quad per run of equal heights. An absent neighbour counts as water (y=0).
    - deck slabs are included, and pillars come from negative `deck`.
  - **vertex AO:**
    - top vertices get Minecraft-style corner occlusion from the three neighbouring heights.
    - side faces darken over the bottom block.
  - **UVs (LOD0 only):**
    - UVs are world-scaled, so the existing `grainTexture()` gives a constant 1-block grain.
    - wall UVs: u is the block along the wall, v is y. They sample a 128 px window atlas (8×8 blocks, 16 px per block) from `city/textures.js`.
    - the atlas has a lit-window emissive map, faded in at night and picked up by bloom.
  - **output:**
    - LOD0 is two meshes per chunk: opaque (terrain, roofs, decks) and walls.
    - LOD1 and LOD2 are **one mesh per region**, using vertex colour only. At night, wall vertices get a flat emissive tint instead of the atlas.
    - positions are region- or chunk-local Float32, colours Uint8 normalised, indices Uint32.
- **LOD and regions:** distance is the Chebyshev distance in chunks from `controls.target`, with ±0.5 hysteresis.
  - **LOD0:** r ≤ 1 (3×3 = 9 chunks). Per-chunk meshes, full detail, cast and receive shadows.
  - **region:** a 4×4-chunk tile aligned to `cx,cz` multiples of 4. The v1 area is 6×9 = 54 regions (edge regions are partial).
    - a region is LOD1 if its nearest chunk is at r ≤ 5, else LOD2.
    - its mesh skips the LOD0 chunks inside it (`skip`).
    - it is re-meshed when its skip set or LOD changes. At most 4 regions touch LOD0 at once.
  - **LOD1:** 2×2 downsample at max top, receives shadows, no cast.
  - **LOD2:** 4×4 downsample.
  - per frame: at most 2 mesh uploads. Replaced meshes are disposed.
  - frustum culling is on, with one bounding box per mesh.
  - **budget arithmetic at spawn** (distance 600):

    | item | worst-case draw calls |
    |---|---|
    | LOD0 (9 × 2 meshes) | 18 |
    | shadow pass (LOD0 casters) | 18 |
    | regions (54 × 1) | 54 |
    | water planes, sky, labels' 3D parts, pins | about 6 |
    | composer and bloom passes | about 10 |
    | **total** | **about 106** |

    - triangles: LOD0 ≤25k per chunk × 9 = 225k, plus the shadow pass, which re-draws the same 225k.
    - LOD1 is ≤6k per chunk-equivalent: (121 − 9) × 6k ≈ 670k.
    - LOD2 is ≤1.5k per chunk: (693 − 121) × 1.5k ≈ 860k before culling.
    - the worst case before culling is about 2.0M. The gate is set after frustum culling.
    - **gate:** calls ≤150 and tris ≤1.5M as counted by `renderer.info` with `autoReset=false`, reset once at frame start, so **shadow and composer passes count**.
- **Camera:**
  - fov 30, near 1, far 6000.
  - polar angle 0.32..1.2, distance 30..2500.
  - target clamped to the manifest bbox.
  - `target.y` lerps to `groundAt(target)` so panning glides over hills.
  - fog near/far = dist×1.5 / dist×4.5, clamped to the far plane.
- **Shadows:** a 2048 sun map with an orthographic box of ±128 blocks around the target, snapped to texels.
- **Style:** colours live in `public/shared/city.js` (owned by W4 after W1, see section 5), taken from the scale scout's palette.

  | element | colours |
  |---|---|
  | asphalt | #4a4d52 |
  | sidewalk | #c9c4ba |
  | grass | #7cbf5a |
  | park | #6aad4d |
  | forest | #4f8a3c |
  | water | #3d7fb3 |
  | shallow | #5aa0cf |
  | sand | #e9d8a6 |
  | pier | #8b6b4a |
  | rail | #6b6158 |
  | plaza | #d8cdbd |
  | hill grass | #c8b273 |
  | parking | #8d8f93 |
  | pastels | #f4c6c6, #c9e2f0, #f6e3a6, #cfe8c9, #e4d3f2, #fbf6ec |
  | brick and stucco | #a65a44, #8c4a3a, #e9dfcf, #d8cdbd, #b9b3a8 |
  | stone | #cfcac0, #b5afa5, #9f9a92, #e2ddd3 |
  | glass | #7fa6c4, #5e86a8 |
  | landmarks | Salesforce #e8e6df, Transamerica #f2efe8 |

  - roofs are 12% darker than the walls.
  - the warm office lighting tone is kept.
- **Picking** (`pick.js`, pure): voxel DDA over the decoded store, `pickRay(store, origin, dir, maxDist) → {x,y,z,cx,cz,kind:"building"|"ground"|"water"|"deck", buildingId?, surface?} | null`. Large meshes are never raycast.
- **Scene API** (W5 delivers, W6 consumes): `createCityScene(container, {manifestUrl}) → Promise<city>`, with:
  - `city.manifest`
  - `city.store` (`get(cx,cz)`)
  - `city.setTheme("day"|"night")`
  - `city.focus(x,z,dist?)` (animated)
  - `city.onFrame(fn)`
  - `city.pick(clientX,clientY)`
  - `city.worldToScreen(x,y,z) → {x,y,visible}`
  - `city.groundAt(x,z)`
  - `city.buildingAt(x,z) → {id,base,top}|null`
  - `city.cameraDistance()`
  - `city.add(obj3d)` / `city.remove(obj3d)`
  - `city.THREE`, the three namespace for W6.
  - `city.stats() → {fps,calls,tris,chunks:{lod0,regions1,regions2,pending}}`, also exposed as `window.__city`.
- **URL state:**
  - `?at=x,z,dist` (W5)
  - `?theme=day|night` (W5)
  - `?debug=1` stats HUD (W5)
  - `?c=<companyId>` (W6)
  - `?pins=demo` demo pins (W6)
- **Labels and UI (W6):**
  - DOM chips with the company name sit at `roofY+2` above the primary site.
  - labels are culled to ≤24 visible, by screen overlap and distance. The company list order breaks ties.
  - former sites are shown greyed.
  - **clicking a building** opens a panel listing every company site in that building, each with:
    - name and address
    - status and category
    - "verified <date>"
    - source links
    - building height in metres, `(top-base)*3`
  - clicking a building with no company shows "building · N m".
  - there is no office link in v1 (see section 1).
  - search box: type a company name to fly there.
  - the attribution footer is always visible.
- **Agents** (`pins.js`; W6 builds it now and runs it on demo data only):
  - `createPins(city, sites) → {setPresence([{companyId, agents:[{id,name,hue,status}]}])}`.
  - **scale** (from section 1's office mapping):
    - each pin is a blocky figure **0.6 block tall** (1.8 m) and **0.25 block wide**, with legs, torso and head boxes merged.
    - every pin is smaller than one building column.
  - drawn with one InstancedMesh, coloured per instance by hue: one draw call in total.
  - pins are shown only when `city.cameraDistance() ≤ 200`. Beyond that, the company's label chip shows an agent-count badge instead.
  - pins are placed on the primary site's `anchor` sidewalk column, 4 per column in a 2×2 sub-grid, filling columns away from the door. A company gets at most 12 pins, then a "+N" chip.
  - `buildCharacter` is never used here.
  - the live feed is phase 2:
    - an opt-in `city:{companyId}` field on office meta.
    - a public `GET /api/city/sf` returning `[{companyId, agentCount, agents:[{name,hue,status}]}]`, with no office ids or keys.
    - cached 15 s and polled every 20 s.

## 4. companies

**Source file:** `scripts/city/sf/companies.src.json`, curated by hand and committed. Each entry:

`{id, companyId, name, primary, address, easId?, status:"hq"|"office"|"former"|"landmark", category, color, sources:[{url, kind:"occupancy"|"registry"|"news"|"company", date?}], verifiedAt:"YYYY-MM-DD", hint:{lat,lon,from:<url>|"scout"}, note?, ship:true|false}`

- `hint.from` records where the hint point came from. A `"scout"` hint is allowed but is flagged in output and in the report.
- `easId` pins the EAS record when there are multiple hits (rule 2).

**Output:** `public/city/sf/companies.json`:

`{version:1, city:"sf", builtAt, sites:[{...src fields minus ship/hint/easId, lat, lon, eas:{id,parcel}, hintFrom, buildingId, block:{x,z}, chunk:[cx,cz], anchor:{x,y,z}, roofY, heightM, placement:"contains"|"nearest", placementDistM}]}`

**Rules in `companies-sf.mjs`. Each one fails the run loudly:**

1. **Sources.** A shipped site needs at least one source and a `verifiedAt`.
   - `hq` and `office` need at least one `occupancy` source: the company's careers, contact or office page, or dated lease or move news.
   - a Registered Business Locations (g8m3-pdis) record has `kind:"registry"`. It can corroborate, but it is never enough on its own for `hq` or `office`, because it often holds a registered-agent or mailing address.
   - `former` needs a dated news or company source showing occupancy and departure.
   - entries that so far rest only on the scout's memory are not shipped.
2. **EAS geocoding** (authoritative; `lib/eas.mjs`):
   - **normalisation**, applied to both the source address and the EAS fields:
     - uppercase.
     - strip suite, unit, floor and `#…` parts.
     - collapse whitespace.
     - spelled ordinals become numeric (`THIRD→3RD`).
     - street types are abbreviated (`STREET→ST`, `AVENUE→AVE`, `BOULEVARD→BLVD`, `PLACE→PL`).
     - a number range `1455-1515` queries the first number, and the range goes into `note`.
   - query by number plus normalised street name plus type. W3 pins the EAS column names (number, street name, type, point, parcel) from the dataset's column list in `eas.mjs` before writing the query.
   - **multiple hits:**
     - if all points are within 10 m, take the lowest EAS id.
     - otherwise fail unless `easId` is set.
   - fail if there is no match, or if the EAS point is more than 60 m from `hint`. The error names `hint.from`.
   - responses are cached under `raw/eas/<id>.json`.
3. **Bbox.** The site must lie inside the built bbox. Sites outside it are listed as skipped, for example ILM in the Presidio.
4. **Placement** uses the chunk `bldg` grid:
   - if the EAS column is a building, placement is `contains`.
   - else the nearest building column within 15 blocks (45 m) is taken, with placement `nearest`.
   - else the build fails.
5. **Anchor.** The anchor is the nearest non-building, non-water column to the EAS point within 12 blocks, preferring SIDEWALK, then PLAZA, then ROAD. If none exists the build fails. `y` = ground.
6. **Shared buildings.** Several sites may share a building, for example 415 Mission (Salesforce and Slack) and 303 2nd St (Scale, Reddit, DoorDash).
7. **Campuses.** A campus is several sites under one `companyId` with exactly one `primary`, for example OpenAI at 1455 3rd St (primary), 1515 3rd St and 550 Terry Francois.
8. **Conflicting addresses**, for example Anthropic at 500 Howard (lease news) against 400 Howard (business registry):
   - the address with the newest dated `occupancy` source becomes `primary` with status `hq`.
   - another address with its own occupancy source ships as `office`.
   - a registry-only address is not shipped.
   - if neither has an occupancy source, the company is not shipped. The W6 "search anthropic" gate then switches to a different shipped company (see W6).

**v1 roster:**

- ship the scout's high- and medium-confidence entries inside the bbox, at least 40 sites, once each meets rule 1.
- not shipped until verified: Perplexity, Sierra, Mixpanel, Benchling, Mozilla, Hims & Hers, Twilio, Webflow, Anchor Brewing, GitHub.
- shipped as `former`: X, Block (1455 Market), PG&E, Cruise.
- no logos, only a name and a colour.

## 5. workstreams

W1 goes first and is small, about half a day: it lays down the contract and stub files with the final signatures. After that, W2–W6 run in parallel against the fixture city, and each stub's ownership passes to the listed workstream. No file is edited by two workstreams.

- **Gates marked [post-int]** need W2's real output. They are verified only in the final integration step, not when a workstream lands. Each workstream also has a fixture equivalent that it must pass before it lands.
- **Shared contract ownership:** after W1, `public/shared/city.js` and `city.d.ts` are **owned by W4**.
  - other workstreams request changes (colours, enums, constants) from W4 with the exact diff. W4 applies or rejects them the same day.
  - any change to the binary format or manifest shape bumps `CITY_VERSION` and needs W2 sign-off.

**W1: contract, fixture, plumbing**

- **Files:**
  - `public/shared/city.js` and `public/shared/city.d.ts`. These export:
    - `CITY_VERSION`, `BLOCK_M`, `CHUNK`, `SF_PROJ`, `OFFICE_CELL_BLOCKS`
    - `lonLatToBlock`, `blockToLonLat`, `chunkOf`, `chunkKey`, `regionOf`
    - `SURFACE` enum (WATER 1, SHALLOW 2, SAND 3, GRASS 4, PARK 5, FOREST 6, ROAD 7, SIDEWALK 8, RAIL 9, PLAZA 10, PIER 11, HILL 12, PARKING 13)
    - `SURFACE_COLORS`, `BUILDING_PALETTE`, `PALETTE_GROUPS`
    - `encodeChunk`, `decodeChunk`, `isGzip`, `validateManifest`, `validateCompanies`
  - `scripts/city/fixture.mjs`
  - `public/city/fixture/**` (generated, committed): 4×4 chunks containing:
    - a hill rising to 30
    - a water strip with a pier and one building standing on the pier
    - a 4-wide road with sidewalks
    - 10 towers up to 100
    - a deck with pillars (negative `deck`)
    - a sloped lot showing the base/top rule
    - 3 companies, one of them sharing a building
  - `scripts/city/check.mjs`
  - `scripts/city/checks/format.check.mjs`
  - `package.json`: adds `pngjs@7.0.0` and every npm script in section 2.
  - `.gitignore`: adds `/data/`.
  - stubs for every other new file, including `scripts/city/perf.mjs` and `scripts/city/checks/geo.check.mjs`.
- **Acceptance:**
  - `npm run check:city` passes:
    - the encode/decode roundtrip is byte-identical, including negative `deck`.
    - projection roundtrip error is under 0.01 block.
    - every row of the section 1 anchor table matches within 0.2 blocks with the exact chunk.
    - `decodeChunk` on HTML bytes throws.
  - the fixture is under 200 KB.
  - `npm run check` is still green.
  - the operator signs off the section 0 decisions on `/city/fixture`. The page renders once W5 lands; until then the sign-off uses the fixture's `topdown.png`.

**W2: map data pipeline**

- **Files:**
  - `scripts/city/fetch-sf.mjs`, `build-sf.mjs`, `verify-sf.mjs`
  - `scripts/city/lib/{http,geo,raster,terrain,mask,osm,buildings}.mjs`
  - `scripts/city/sf/{config.mjs,overrides.json}`
  - `scripts/city/checks/{raster,geo}.check.mjs`
  - generated: `public/city/sf/{manifest.json,chunks/*,LICENSE.txt}`
- **Acceptance:**
  - fetch is idempotent. `--force` re-downloads, subject to the Overpass 24 h cooldown.
  - build meets the section 2 budgets. `report.json` holds total bytes and the all-water chunk count.
  - all manifest chunks exist and decode.
  - **coverage:** at least 90% of the total in-bbox DataSF footprint area is covered by columns carrying that footprint's own id. Overlaps lost to taller neighbours are reported.
  - `geo.check.mjs` passes, including the ring-assembly cases.
  - `verify-sf.mjs` known points:
    - Ferry Building ground = 1, and its columns are building or PIER, not water.
    - Grace Cathedral (37.7919, −122.4134) ground 34±3.
    - Coit Tower base (37.8024, −122.4058) 28±3.
    - Salesforce Tower `top-base` 109±3, which proves the OSM merge.
    - Transamerica 87±3.
    - 1455 3rd St ground 1–2.
    - Pier 39 (37.8087, −122.4098) is PIER or a building, not WATER.
    - Mission Creek channel is WATER.
    - McCovey Cove is WATER.
    - the Embarcadero roadway in front of the Ferry Building is ROAD with ground ≥1.
    - the Bay is water east of the Embarcadero.
    - W2 pins exact points for the Mission Creek, McCovey Cove and Embarcadero checks from OSM in `config.mjs`.
  - **water/land gate:** among in-bbox DataSF footprint centroids, at most 0.5% fall on WATER columns.
  - the operator checks `data/city/sf/build/topdown.png` visually.

**W3: companies**

- **Files:**
  - `scripts/city/sf/companies.src.json`
  - `scripts/city/companies-sf.mjs`
  - `scripts/city/lib/eas.mjs`
  - `scripts/city/checks/companies.check.mjs`
  - generated: `public/city/sf/companies.json`
- **Acceptance:**
  - at least 40 shipped sites, all meeting section 4 rule 1.
  - the script applies the section 4 rules and fails loudly.
  - the EAS normalisation has unit cases: suite stripping, `THIRD`, ranges, and multiple hits.
  - the Anthropic decision is recorded with its sources under rule 8.
  - the check verifies, against the decoded chunk at `block`, that every `buildingId` exists, every anchor column is non-building and non-water, and `validateCompanies` passes.
  - fixture: the 3 fixture companies place correctly, including the shared building.
  - [post-int] Salesforce `heightM` ≥ 300.
  - [post-int] OpenAI primary is 1455 3rd St. The provisional OpenAI anchor row is updated to the EAS point.

**W4: mesher, worker, picking, city textures, shared contract**

- **Files:**
  - `public/js/city/{mesher.js,mesher.worker.js,pick.js,textures.js}`
  - `public/shared/{city.js,city.d.ts}` (after W1)
  - `scripts/city/checks/{mesher,pick}.check.mjs`
  - `scripts/city/perf.mjs`
- **Acceptance** (node, headless, in `check:city`):
  - a flat single-class chunk with four equal-height, same-class neighbours produces exactly 2 top triangles and no sides.
  - the same chunk with absent neighbours produces border sides down to y=0.
  - a 1×1 tower of height h on flat ground produces 1 top quad and 4 side quads for the tower's own faces. The surrounding ground mesh is excluded from the count.
  - neighbour culling: two equal-height adjacent chunks emit no border sides.
  - a negative `deck` column emits a pillar.
  - on the fixture, the LOD1 region triangle count is ≤30% of LOD0 for the same chunks.
  - `mesher.js` has no imports other than `shared/city.js`.
  - `pick` straight down onto a tower returns its `buildingId`, and a ray over water returns water.
  - [post-int] the real downtown chunk (56,26) produces ≤25k triangles at LOD0.
  - **report only** (`npm run city:perf`, not in `check`): meshing time for chunk (56,26), with a target of ≤15 ms.

**W5: viewer core**

- **Files:**
  - `public/js/app.js` (the route branch only)
  - `public/js/city/{app.js,stage.js,scene.js,loader.js}`
  - the City section of `README.md`
- **Acceptance:**
  - `/city/fixture` renders with no console errors. [post-int] So does `/city/sf`.
  - `/`, `/o/:office` and `?demo=1` office views are unchanged.
  - `/city/fixture?demo=1` does not trigger office demo logic.
  - `npm run check` passes.
  - touch works at 390×844 in yab with touch emulation: pan, pinch and tap-pick, with no horizontal scroll.
  - `?theme=night` shows lit windows with bloom.
  - renaming one chunk file locally gives a visible error banner.
  - **report only:**
    - [post-int] at spawn on an M-series laptop, `window.__city.stats()` shows calls ≤150 and tris ≤1.5M, counted with shadow and composer passes, and fps ≥50.
    - panning glides over Nob Hill.
- **Preview:** `npm run dev`, then yab opens `http://localhost:8799/city/sf?debug=1`.

**W6: city UI and agents**

- **Files:**
  - `public/js/city/{ui.js,labels.js,panel.js,search.js,pins.js}`
  - `public/css/city.css`
  - `scripts/city/checks/ui.check.mjs`, covering the pure label-cull and pin-layout functions
- **API:** `mountCityUi(city, companies, root)` is the single entry point, called by W5's `app.js`.
- **Acceptance:**
  - fixture:
    - labels appear for the 3 companies.
    - clicking the shared building lists both of its companies with address and sources.
    - `?c=<fixture id>` flies to the building.
    - the attribution footer is visible.
  - `ui.check.mjs`:
    - the pin bounding box is under 1 block tall and ≤0.25 block wide.
    - layout puts at most 4 pins per column and at most 12 per company, with "+N" beyond that.
  - on screen, at distance 150 the pin's projected height is less than the projected height of a 1-block column at the same spot (W6 logs this in `?debug=1`).
  - [post-int] clicking 415 Mission shows Salesforce and Slack with address and sources.
  - [post-int] search "anthropic" flies to Anthropic's primary building. If rule 8 left Anthropic unshipped, the gate uses "openai" instead.
  - [post-int] `?c=openai` flies to 1455 3rd St.
  - [post-int] `?pins=demo` puts pins at 10 or more companies with one added draw call. The pins are hidden beyond distance 200 and badge counts show instead.

**Order:**

1. W1, followed by the operator sign-off from section 0.
2. W2, W3, W4, W5 and W6 in parallel, all on the fixture.
3. Integration: `npm run city:build`, then `npm run check`.
4. All [post-int] gates.
5. `npm run city:perf` and the W5 report-only numbers.
6. A yab preview of `/city/sf`.

**Phase 2** is not v1:

- the whole city: same projection, about 3000 land chunks, possibly bundled into 8×8 region files.
- Twin Peaks, the Presidio and the Marina.
- hand-made landmark kinds (Transamerica pyramid, Salesforce crown, Coit, Ferry Building, Bay Bridge), using `roof` values above 0.
- stacked decks.
- road markings.
- the presence API in `src/worker.ts`, `src/office.ts` and `src/registry.ts`, plus the opt-in "open office" link.
- extracting a shared stage from `scene.js`.

## 6. risks and cut-lines

**Risks:**

- **DataSF heights are from 2010.** Mitigated by the OSM merge (gated at 60 m), `overrides.json`, the `peak_1st_m` report, and the Salesforce known-point gate.
- **The shoreline is wrong when taken from the DEM.** Mitigated by the vector mask, the land floor of 1, pier and building-on-water rules, and the water/land known points and gate.
- **Overpass is flaky** (406 without a UA, 502 at capacity). Mitigated by the raw cache, retries, the 24 h `--force` cooldown, and building from cache only. A BBBike or Geofabrik `.pbf` is the fallback, at the cost of a reader dependency.
- **Multipolygon and coastline assembly bugs.** Mitigated by ring-assembly checks and the 1% unclosable gate.
- **Rotated SoMa/Mission grids render as staircases at 3 m.** Accepted as Minecraft style, subject to the operator's section 0 confirmation.
- **The 141 MB GeoJSON can blow memory.** `within_box` plus the field `$select` keeps it small; stream-parse if the fallback is needed.
- **Company addresses go stale** (HQs move). The occupancy-source rule, EAS, `verifiedAt` and recorded `hint.from` mean nothing ships from memory.
- **ODbL share-alike.** Scoped to `public/city/**` in `LICENSE.txt`, with the repo staying MIT and attribution always shown. The joerd source list is stored verbatim.
- **SPA fallback returns index.html with status 200.** The manifest list plus gzip-magic check turns that into a loud error.
- **Module workers have no importmap.** Hence the rule that the mesher has no `three` import.
- **Draw calls and fill rate on integrated GPUs.** Mitigated by region meshes beyond LOD0, the 25k-per-chunk LOD0 budget, DPR capped at 1.25 with adaptive fallback, and no point lights.
- **Integration gates arrive late.** Fixture equivalents gate every workstream before it lands. [post-int] gates are scheduled explicitly.
- **~200 lines of stage duplication** are tracked as phase-2 debt.

**Cut-lines, dropped in this order if the work runs over:**

1. bridges and decks. Motorway bridge ways are not drawn at all, rather than drawn as fake flat roads.
2. LOD2 (all regions use LOD1 downsampling).
3. night emissive windows (night becomes a dark theme only).
4. search.
5. dynamic shadows (AO only).
6. pins and demo presence.
7. OSM gap-fill buildings (keep only the top-30 tower height overrides).
8. shrinking the bbox to cx 51..59, cz 19..27 (FiDi/SoMa core, 81 chunks). Anchors outside that box (Ghirardelli, Grace, Coit, Pier 39, OpenAI) move to "skipped" in `verify-sf.mjs`, which does not fail the run.

**Never cut:** real elevation at 1:1, the vector water mask, sources and EAS for every company, the attribution footer, and loud errors on bad data.