// Blocky voxel office-mates (our own design): a big cube head with a pixel face and one of five hair
// styles, a hue-coloured shirt, arms and legs on pivots the animator drives. Feet at y = 0, facing +z.

import * as THREE from "three";
import { vbox, buildGeometry } from "./voxel.js";
import { hashStr, hueColors } from "./model.js";
import { SEAT_Y } from "./furniture.js";

export const LEG_H = 0.4;
export const BODY_H = 0.46;
export const HEAD = 0.46;
export const CROWN = LEG_H + BODY_H + HEAD + 0.06;

const SKINS = ["#f6d3b3", "#eabf98", "#d9a27a", "#b97d55", "#8d5a3b", "#f3c9a5"];
const HAIRS = ["#3a2a22", "#6b4630", "#d9a35a", "#1f1f27", "#a8442e", "#e7d3a1", "#5a6cc4", "#f08bb0"];
const PANTS = ["#3d4a66", "#4a4f5c", "#5b4a3f", "#34495e", "#6b5b7b"];
const STYLES = ["crop", "bob", "bun", "spiky", "cap"];

export function lookFor(agent) {
  const h = hashStr(agent.id || agent.name);
  return {
    skin: SKINS[h % SKINS.length],
    hair: HAIRS[(h >>> 4) % HAIRS.length],
    pants: PANTS[(h >>> 8) % PANTS.length],
    style: STYLES[(h >>> 12) % STYLES.length],
    ...hueColors(agent.hue ?? 0),
  };
}

function hairBoxes(style, hair, accent) {
  const H = HEAD, top = H;
  const b = [];
  if (style === "cap") {
    b.push(vbox(0, top - 0.1, 0, H + 0.04, 0.16, H + 0.04, accent));
    b.push(vbox(0, top - 0.1, H / 2 + 0.1, H * 0.8, 0.04, 0.22, accent));
    b.push(vbox(0, top - 0.24, -0.02, H + 0.03, 0.14, H - 0.02, hair));
    return b;
  }
  b.push(vbox(0, top - 0.08, 0, H + 0.04, 0.12, H + 0.04, hair));
  b.push(vbox(0, top - 0.3, -H / 2 + 0.03, H + 0.04, 0.24, 0.1, hair));
  if (style === "crop") {
    b.push(vbox(0, top - 0.14, H / 2 - 0.02, H + 0.04, 0.08, 0.06, hair));
  } else if (style === "bob") {
    b.push(vbox(-H / 2 - 0.01, top - 0.38, 0, 0.06, 0.34, H + 0.02, hair));
    b.push(vbox(H / 2 + 0.01, top - 0.38, 0, 0.06, 0.34, H + 0.02, hair));
    b.push(vbox(0, top - 0.42, -H / 2 + 0.03, H + 0.06, 0.34, 0.1, hair));
    b.push(vbox(0.08, top - 0.16, H / 2, H * 0.7, 0.1, 0.06, hair));
  } else if (style === "bun") {
    b.push(vbox(0, top + 0.02, -0.08, 0.2, 0.16, 0.2, hair));
    b.push(vbox(0, top - 0.14, H / 2 - 0.02, H + 0.04, 0.08, 0.06, hair));
  } else if (style === "spiky") {
    for (const [x, z, s] of [[-0.12, 0.08, 0.12], [0.1, 0.1, 0.1], [0, -0.08, 0.14], [0.14, -0.1, 0.1], [-0.14, -0.12, 0.1]]) {
      b.push(vbox(x, top + 0.02, z, s, s, s, hair));
    }
    b.push(vbox(0, top - 0.14, H / 2 - 0.02, H + 0.04, 0.08, 0.06, hair));
  }
  return b;
}

function faceBoxes(look) {
  const z = HEAD / 2 + 0.005;
  return [
    vbox(-0.11, 0.255, z, 0.1, 0.03, 0.01, look.hair, { faces: [4] }),
    vbox(0.11, 0.255, z, 0.1, 0.03, 0.01, look.hair, { faces: [4] }),
    vbox(-0.175, 0.1, z, 0.07, 0.04, 0.01, "#f29a9a", { faces: [4] }),
    vbox(0.175, 0.1, z, 0.07, 0.04, 0.01, "#f29a9a", { faces: [4] }),
    vbox(0, 0.075, z, 0.08, 0.025, 0.01, "#9c4f45", { faces: [4] }),
  ];
}

const sharedMats = new Map();
function voxMat(key, opts) {
  if (!sharedMats.has(key)) sharedMats.set(key, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, ...opts }));
  return sharedMats.get(key);
}

/** Build one character. Returns a Group with userData.parts (pivots) and userData.dispose(). */
export function buildCharacter(agent, grain) {
  const look = lookFor(agent);
  const m = voxMat("base", { map: grain });
  const geos = [];
  const mk = (boxes, opts) => { const g = buildGeometry(boxes, { ao: true, floorY: -99, ...opts }); geos.push(g); return g; };
  const mesh = (g, mat = m) => {
    const o = new THREE.Mesh(g, mat);
    o.castShadow = true;
    o.receiveShadow = true;
    return o;
  };

  const root = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = LEG_H;
  root.add(hips);

  const leg = (side) => {
    const p = new THREE.Group();
    p.position.set(side * 0.105, 0, 0);
    p.add(mesh(mk([
      vbox(0, -LEG_H + 0.08, 0, 0.19, LEG_H - 0.08, 0.2, look.pants),
      vbox(0, -LEG_H, 0.02, 0.2, 0.09, 0.24, "#2b2b33"),
    ])));
    hips.add(p);
    return p;
  };
  const legL = leg(1), legR = leg(-1);

  const torso = new THREE.Group();
  hips.add(torso);
  torso.add(mesh(mk([
    vbox(0, 0, 0, 0.42, BODY_H, 0.24, look.shirt),
    vbox(0, BODY_H - 0.06, 0.005, 0.18, 0.06, 0.245, look.skin),
    vbox(0, 0, 0.005, 0.43, 0.06, 0.245, look.shirtDark),
    vbox(0.11, 0.3, 0.121, 0.08, 0.08, 0.01, look.accent, { faces: [4] }),
  ])));

  const head = new THREE.Group();
  head.position.y = BODY_H;
  torso.add(head);
  head.add(mesh(mk([vbox(0, 0, 0, HEAD, HEAD, HEAD, look.skin), ...hairBoxes(look.style, look.hair, look.shirt)])));
  head.add(mesh(mk(faceBoxes(look), { ao: false })));
  const eyes = mesh(mk([
    vbox(-0.11, 0.14, HEAD / 2 + 0.006, 0.08, 0.09, 0.01, "#25222b", { faces: [4] }),
    vbox(0.11, 0.14, HEAD / 2 + 0.006, 0.08, 0.09, 0.01, "#25222b", { faces: [4] }),
    vbox(-0.09, 0.19, HEAD / 2 + 0.008, 0.03, 0.03, 0.01, "#ffffff", { faces: [4] }),
    vbox(0.13, 0.19, HEAD / 2 + 0.008, 0.03, 0.03, 0.01, "#ffffff", { faces: [4] }),
  ], { ao: false }));
  eyes.castShadow = false;
  eyes.geometry.translate(0, -0.185, 0);
  eyes.position.y = 0.185;
  head.add(eyes);

  const arm = (side) => {
    const p = new THREE.Group();
    p.position.set(side * 0.29, BODY_H - 0.06, 0);
    p.add(mesh(mk([
      vbox(0, -0.2, 0, 0.15, 0.24, 0.16, look.shirt),
      vbox(0, -0.4, 0, 0.14, 0.2, 0.15, look.skin),
    ])));
    torso.add(p);
    return p;
  };
  const armL = arm(1), armR = arm(-1);

  root.userData.parts = { hips, torso, head, eyes, armL, armR, legL, legR };
  root.userData.look = look;
  root.userData.dispose = () => { for (const g of geos) g.dispose(); };
  return root;
}

/** Drive the rig from limbAngles() output; seated characters sit at seatY. */
export function applyLimbs(ch, a, seatY = SEAT_Y) {
  const p = ch.userData.parts;
  p.legL.rotation.x = a.legL; p.legR.rotation.x = a.legR;
  p.armL.rotation.x = a.armL; p.armR.rotation.x = a.armR;
  p.armL.rotation.z = a.armLz; p.armR.rotation.z = -a.armRz;
  p.head.rotation.y = a.head; p.head.rotation.x = a.headTilt;
  p.torso.rotation.x = a.lean;
  p.hips.position.y = (a.seated ? seatY + 0.02 : LEG_H) + a.bob;
}

export function blink(ch, t, phase) {
  const k = ((t + phase * 3.7) % 4.2);
  ch.userData.parts.eyes.scale.y = k < 0.12 ? 0.15 : 1;
}

/** Translucent, desaturated material for "away" agents. */
export function awayMaterial(grain) {
  return voxMat("away", { map: grain, transparent: true, opacity: 0.55, color: "#9aa0b4" });
}
export function baseMaterial(grain) {
  return voxMat("base", { map: grain });
}
