// Box lists → one merged BufferGeometry with vertex colours, world-scaled UVs (so the 16px grain reads
// as voxels of a constant size) and cheap baked ambient occlusion: vertices touching the floor or
// another box get darker, which gives the soft contact shading a shader pack would.

import * as THREE from "three";
import { cornerPoint, quadNormal } from "./shape.js";

// face: normal, then the two in-plane axes (u, v) and which corner coordinates to take
const FACES = [
  { n: [1, 0, 0], corners: [[1, 0, 1], [1, 0, 0], [1, 1, 1], [1, 1, 0]], uv: [2, 1], flipU: true },
  { n: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1]], uv: [2, 1] },
  { n: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [0, 1, 0], [1, 1, 0]], uv: [0, 2] },
  { n: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]], uv: [0, 2] },
  { n: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]], uv: [0, 1] },
  { n: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0]], uv: [0, 1], flipU: true },
];
export const FRONT = 4;

/**
 * A box: {at:[cx, y0, cz] (centre x/z, bottom y), size:[w, h, d], color, faces?: number[] (subset of
 * FACES indices), unitUV?: true (UV 0..1 per face, for textured screens), slope?: "+x"|"-x"|"+z"|"-z" and
 * lowFrac?: 0..1 (a wedge: the top slopes down to lowFrac·h on that side, see shape.js)}.
 */
export function vbox(cx, y0, cz, w, h, d, color, extra = {}) {
  return { at: [cx, y0, cz], size: [w, h, d], color, ...extra };
}

function inside(p, b, eps) {
  const [cx, y0, cz] = b.at, [w, h, d] = b.size;
  return p[0] >= cx - w / 2 - eps && p[0] <= cx + w / 2 + eps && p[1] >= y0 - eps && p[1] <= y0 + h + eps && p[2] >= cz - d / 2 - eps && p[2] <= cz + d / 2 + eps;
}

/** How much a box grows (each side) per earlier box it overlaps: enough to win the depth test, too little to see. */
const NEST_GROW = 0.002;

/**
 * Overlapping boxes often share a face plane (a hair band flush with the head's sides, records flush with a cabinet
 * front); those faces z-fight and flicker, worst on a far-off camera or a weaker depth buffer. Each box grows a hair
 * per box it sits on top of, so the later one always shows, as whoever stacked them meant.
 */
export function unfight(boxes) {
  const lo = (b, i) => (i === 1 ? b.at[1] : b.at[i] - b.size[i] / 2), hi = (b, i) => lo(b, i) + b.size[i];
  const over = (a, b) => [0, 1, 2].every((i) => lo(a, i) < hi(b, i) && lo(b, i) < hi(a, i));
  const layer = [];
  return boxes.map((b, i) => {
    let l = 0;
    for (let j = 0; j < i; j++) if (over(b, boxes[j])) l = Math.max(l, layer[j] + 1);
    layer.push(l);
    if (!l) return b;
    const e = l * NEST_GROW, sink = b.at[1] > 0 ? e : 0;
    return { ...b, at: [b.at[0], b.at[1] - sink, b.at[2]], size: [b.size[0] + 2 * e, b.size[1] + sink + e, b.size[2] + 2 * e] };
  });
}

/** Merge boxes into one geometry. `ao` false skips occlusion (e.g. glowing screens). */
export function buildGeometry(boxes, { ao = true, floorY = 0 } = {}) {
  boxes = unfight(boxes);
  const pos = [], nor = [], col = [], uv = [], idx = [];
  const c = new THREE.Color();
  let v = 0;
  for (const [bi, b] of boxes.entries()) {
    c.set(b.color);
    const faces = b.faces ?? [0, 1, 2, 3, 4, 5];
    for (const fi of faces) {
      const F = FACES[fi];
      const pts = F.corners.map((corner) => cornerPoint(b, corner));
      // a wedge tilts its top and trims its sides: one flat normal per face, and the face its low edge squashed is dropped
      const n = b.slope ? quadNormal(...pts) : F.n;
      if (b.slope && n[0] === 0 && n[1] === 0 && n[2] === 0) continue;
      for (const [ci, corner] of F.corners.entries()) {
        const p = pts[ci];
        pos.push(p[0], p[1], p[2]);
        nor.push(...n);
        let k = 1;
        if (ao) {
          if (p[1] <= floorY + 0.015) k *= 0.62;
          else if (p[1] <= floorY + 0.12) k *= 0.82;
          for (const [oj, o] of boxes.entries()) {
            if (oj === bi || o.unitUV) continue;
            if (inside(p, o, 0.012)) { k *= 0.74; break; }
          }
          if (F.n[1] === -1) k *= 0.8;
        }
        col.push(c.r * k, c.g * k, c.b * k);
        if (b.unitUV) {
          let u = corner[F.uv[0]], vv = corner[F.uv[1]];
          if (F.flipU) u = 1 - u;
          uv.push(u, vv);
        } else {
          let u = p[F.uv[0]], vv = p[F.uv[1]];
          if (F.flipU) u = -u;
          uv.push(u, vv);
        }
      }
      idx.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
      v += 4;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}
