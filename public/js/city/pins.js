// Agent pins: blocky figures 0.6 block tall, 0.25 block wide (1 office cell = 1/4 block), all drawn with one
// InstancedMesh. Placed on the primary site's anchor column, 2×2 per column, filling columns away from the door.
// v1 runs on demo presence only (?pins=demo); the live feed is phase 2.

export const PIN_SIZE = Object.freeze({ h: 0.6, w: 0.25 });
export const PINS_PER_COLUMN = 4;
export const PINS_PER_COMPANY = 12;
export const PINS_MAX_DIST = 200;

const SUB = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Boxes of one pin, feet at the origin: {x, y, z} is the box centre, {w, h, d} its size. tint 1 = takes the agent hue. */
export const PIN_BOXES = Object.freeze([
  { part: "leg", x: -0.0375, y: 0.12, z: 0, w: 0.07, h: 0.24, d: 0.09, color: 0x3d4a66, tint: 0 },
  { part: "leg", x: 0.0375, y: 0.12, z: 0, w: 0.07, h: 0.24, d: 0.09, color: 0x3d4a66, tint: 0 },
  { part: "torso", x: 0, y: 0.35, z: 0, w: 0.15, h: 0.22, d: 0.1, color: 0xffffff, tint: 1 },
  { part: "arm", x: -0.1, y: 0.35, z: 0, w: 0.05, h: 0.22, d: 0.08, color: 0xd9d9d9, tint: 1 },
  { part: "arm", x: 0.1, y: 0.35, z: 0, w: 0.05, h: 0.22, d: 0.08, color: 0xd9d9d9, tint: 1 },
  { part: "head", x: 0, y: 0.53, z: 0, w: 0.14, h: 0.14, d: 0.14, color: 0xf6d3b3, tint: 0 },
].map(Object.freeze));

/** Pure. Axis-aligned bounds of PIN_BOXES. */
export function pinBounds(boxes = PIN_BOXES) {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const p of boxes) {
    b.minX = Math.min(b.minX, p.x - p.w / 2); b.maxX = Math.max(b.maxX, p.x + p.w / 2);
    b.minY = Math.min(b.minY, p.y - p.h / 2); b.maxY = Math.max(b.maxY, p.y + p.h / 2);
    b.minZ = Math.min(b.minZ, p.z - p.d / 2); b.maxZ = Math.max(b.maxZ, p.z + p.d / 2);
  }
  return { ...b, w: b.maxX - b.minX, h: b.maxY - b.minY, d: b.maxZ - b.minZ };
}

function assertInt(v, what) {
  if (!Number.isInteger(v)) throw new Error(`pins: ${what} must be an integer, got ${JSON.stringify(v)}`);
}

/** Pure. Unit step along the dominant axis from the door column to the anchor column, or null when they coincide. */
export function stepAway(anchor, door) {
  const dx = anchor.x - door.x, dz = anchor.z - door.z;
  if (dx === 0 && dz === 0) return null;
  return Math.abs(dx) >= Math.abs(dz) ? { dx: Math.sign(dx), dz: 0 } : { dx: 0, dz: Math.sign(dz) };
}

/**
 * Pure. Lays `count` pins out from the anchor column: 2×2 per column, then the next column one `step` further
 * from the door, up to PINS_PER_COMPANY. → {pins: [{x, y, z, column}], overflow}
 */
export function layoutPins(anchor, count, step) {
  for (const k of ["x", "y", "z"]) assertInt(anchor?.[k], `anchor.${k}`);
  assertInt(count, "count");
  if (count < 0) throw new Error(`pins: count must be ≥ 0, got ${count}`);
  if (!step || Math.abs(step.dx) + Math.abs(step.dz) !== 1) throw new Error(`pins: step must be a unit axis step, got ${JSON.stringify(step)}`);
  const shown = Math.min(count, PINS_PER_COMPANY);
  const pins = [];
  for (let i = 0; i < shown; i++) {
    const column = Math.floor(i / PINS_PER_COLUMN);
    const [ox, oz] = SUB[i % PINS_PER_COLUMN];
    pins.push({ x: anchor.x + step.dx * column + ox, y: anchor.y, z: anchor.z + step.dz * column + oz, column });
  }
  return { pins, overflow: count - shown };
}

function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

const DEMO_STATUSES = ["working", "working", "idle", "waiting"];

/** Pure, deterministic. Demo presence for every non-former primary site: 1..16 agents each (some overflow +N). */
export function demoPresence(sites) {
  return sites
    .filter((s) => s.primary && s.status !== "former")
    .map((s) => {
      const h = hash32(s.companyId);
      const n = 1 + (h % 16);
      const agents = Array.from({ length: n }, (_, i) => ({
        id: `${s.companyId}-demo-${i + 1}`,
        name: `agent ${i + 1}`,
        hue: (hash32(`${s.companyId}:${i}`) % 360),
        status: DEMO_STATUSES[((h >>> 4) + i) & 3],
      }));
      return { companyId: s.companyId, agents };
    });
}

function primaryByCompany(sites) {
  const m = new Map();
  for (const s of sites) if (s.primary) m.set(s.companyId, s);
  return m;
}

function pinGeometry(THREE) {
  const color = new THREE.Color();
  const parts = PIN_BOXES.map((b) => {
    const g = new THREE.BoxGeometry(b.w, b.h, b.d).toNonIndexed();
    g.translate(b.x, b.y, b.z);
    const n = g.attributes.position.count;
    color.setHex(b.color);
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
    return { g, c, t: new Float32Array(n).fill(b.tint) };
  });
  const total = parts.reduce((a, p) => a + p.g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  const tint = new Float32Array(total);
  let o = 0;
  for (const { g, c, t } of parts) {
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); col.set(c, o * 3); tint.set(t, o);
    o += g.attributes.position.count;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("tint", new THREE.BufferAttribute(tint, 1));
  return geo;
}

const INSTANCE_TINT = "vColor.rgb *= instanceColor.rgb;";

/** Lambert with vertex colours where only `tint` parts (torso, arms) take the per-instance hue. */
function pinMaterial(THREE) {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    if (!shader.vertexShader.includes("#include <color_vertex>")) throw new Error("pins: lambert shader has no color_vertex chunk");
    const chunk = THREE.ShaderChunk.color_vertex;
    if (!chunk.includes(INSTANCE_TINT)) throw new Error("pins: three's color_vertex chunk changed; update the pin tint patch");
    shader.vertexShader = "attribute float tint;\n" + shader.vertexShader.replace(
      "#include <color_vertex>",
      chunk.replace(INSTANCE_TINT, "vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, tint);"),
    );
  };
  return material;
}

/** Walkable step for the anchor: the one pointing away from the door when it is open ground, else the first open one. */
function chooseStep(city, site) {
  const away = stepAway(site.anchor, site.block);
  const open = ([dx, dz]) => {
    const x = site.anchor.x + dx, z = site.anchor.z + dz;
    return !city.buildingAt(x, z) && city.groundAt(x + 0.5, z + 0.5) > 0;
  };
  const order = away ? [[away.dx, away.dz], ...DIRS.filter(([dx, dz]) => dx !== away.dx || dz !== away.dz)] : DIRS;
  const pick = order.find(open) ?? order[0];
  return { dx: pick[0], dz: pick[1] };
}

/**
 * One InstancedMesh for every company's pins. Hidden beyond PINS_MAX_DIST; `onCounts` receives
 * Map<companyId, {agents, overflow, pinsVisible}> whenever presence or pin visibility changes, so labels can badge.
 * → {setPresence(presence), update(), dispose(), mesh}
 */
export function createPins(city, sites, { onCounts = () => {} } = {}) {
  const { THREE } = city;
  if (!THREE) throw new Error("createPins: city.THREE is missing");
  const primaries = primaryByCompany(sites);
  const capacity = Math.max(1, primaries.size * PINS_PER_COMPANY);
  const material = pinMaterial(THREE);
  const mesh = new THREE.InstancedMesh(pinGeometry(THREE), material, capacity);
  mesh.name = "city-pins";
  mesh.count = 0;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.visible = false;
  city.add(mesh);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), color = new THREE.Color();
  let counts = new Map();
  let near = null;

  function setPresence(presence) {
    if (!Array.isArray(presence)) throw new Error("setPresence: presence must be an array");
    counts = new Map();
    let n = 0;
    for (const entry of presence) {
      const site = primaries.get(entry?.companyId);
      if (!site) throw new Error(`setPresence: no primary site for company ${JSON.stringify(entry?.companyId)}`);
      if (!Array.isArray(entry.agents)) throw new Error(`setPresence: ${entry.companyId}.agents must be an array`);
      const { pins, overflow } = layoutPins(site.anchor, entry.agents.length, chooseStep(city, site));
      pins.forEach((p, i) => {
        const a = entry.agents[i];
        if (!Number.isFinite(a?.hue)) throw new Error(`setPresence: ${entry.companyId} agent ${i} has no numeric hue`);
        const y = p.column === 0 ? p.y : city.groundAt(p.x, p.z);
        q.setFromAxisAngle(up, ((hash32(String(a.id)) % 8) / 8) * Math.PI * 2);
        mesh.setMatrixAt(n, m.compose(v.set(p.x, y, p.z), q, one));
        mesh.setColorAt(n, color.setHSL((((a.hue % 360) + 360) % 360) / 360, 0.62, 0.56));
        n++;
      });
      counts.set(entry.companyId, { agents: entry.agents.length, overflow, pinsVisible: false });
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    near = null;
    update();
  }

  function update() {
    const isNear = city.cameraDistance() <= PINS_MAX_DIST;
    mesh.visible = isNear && mesh.count > 0;
    if (isNear === near) return;
    near = isNear;
    for (const c of counts.values()) c.pinsVisible = isNear;
    onCounts(counts);
  }

  function dispose() {
    city.remove(mesh);
    mesh.geometry.dispose();
    material.dispose();
    mesh.dispose();
  }

  return { setPresence, update, dispose, mesh };
}
