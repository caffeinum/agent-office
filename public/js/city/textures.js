// City textures: the 128 px window atlas (8×8 blocks, 16 px per block) for LOD0 building walls, and its
// lit-window emissive map for night + bloom. Greyscale so the wall's vertex colour tints it, NearestFilter
// so it reads as chunky voxels like the office. Seeded: every viewer paints the same city.
//
// Wall UVs from the mesher are in blocks (u along the wall, v = y); both textures carry repeat 1/8 and
// RepeatWrapping, so one atlas tile spans 8×8 blocks of facade.
import * as THREE from "three";

export const ATLAS_BLOCKS = 8;
export const ATLAS_PX_PER_BLOCK = 16;
const SIZE = ATLAS_BLOCKS * ATLAS_PX_PER_BLOCK;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const LIT = [[255, 210, 122], [255, 230, 168], [255, 243, 196], [207, 227, 255]];

/** Paint both maps into RGBA byte arrays (pure; no DOM). → {size, map, emissive} */
export function paintWindowAtlas(seed = 131) {
  const r = rng(seed);
  const map = new Uint8ClampedArray(SIZE * SIZE * 4);
  const emissive = new Uint8ClampedArray(SIZE * SIZE * 4);
  const put = (arr, x, y, rgb) => {
    const o = (y * SIZE + x) * 4;
    arr[o] = rgb[0]; arr[o + 1] = rgb[1]; arr[o + 2] = rgb[2]; arr[o + 3] = 255;
  };
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = Math.round(255 * (0.9 + r() * 0.1));
      put(map, x, y, [v, v, v]);
      put(emissive, x, y, [0, 0, 0]);
    }
  }
  const P = ATLAS_PX_PER_BLOCK;
  for (let by = 0; by < ATLAS_BLOCKS; by++) {
    for (let x = 0; x < SIZE; x++) put(map, x, by * P + P - 1, [196, 196, 196]);
    for (let bx = 0; bx < ATLAS_BLOCKS; bx++) {
      const x0 = bx * P, y0 = by * P;
      const blank = r() < 0.08;
      if (blank) continue;
      const twin = r() < 0.3;
      const panes = twin ? [[3, 4], [9, 4]] : [[3, 10]];
      const lit = r() < 0.38;
      const glow = LIT[Math.floor(r() * LIT.length)];
      for (const [px, pw] of panes) {
        for (let y = 3; y < 12; y++) {
          for (let x = px; x < px + pw; x++) {
            const edge = y === 3 || x === px;
            const g = edge ? 58 : 78 + Math.round(r() * 14);
            put(map, x0 + x, y0 + y, [g, g + 6, g + 14]);
            if (lit) {
              const f = edge ? 0.7 : 0.9 + r() * 0.1;
              put(emissive, x0 + x, y0 + y, glow.map((c) => Math.round(c * f)));
            }
          }
        }
        for (let x = px - 1; x < px + pw + 1; x++) put(map, x0 + x, y0 + 12, [236, 236, 236]);
      }
    }
  }
  return { size: SIZE, map, emissive };
}

function texture(pixels, size) {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  c.getContext("2d").putImageData(new ImageData(pixels, size, size), 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / ATLAS_BLOCKS, 1 / ATLAS_BLOCKS);
  t.anisotropy = 4;
  return t;
}

/** → {map: THREE.CanvasTexture, emissiveMap: THREE.CanvasTexture}; fade night in via material.emissiveIntensity. */
export function createWindowAtlas() {
  const { size, map, emissive } = paintWindowAtlas();
  return { map: texture(map, size), emissiveMap: texture(emissive, size) };
}
