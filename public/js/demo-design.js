// ?demo=1 only: what the simulated designer builds — voxel definitions for an arcade cabinet, a brick
// statement wall, a coffee bar and a huddle table (in the shared 16-units-per-cell model space), a
// made-up brand, and a canvas-drawn logo. Pure data + one canvas helper; demo.js plays it out.

export const BRAND = Object.freeze({ name: "Ember Labs", primary: "#e94d3d", dark: "#141414", accent: "#d28f88" });

const box = (x, y, z, w, h, d, color, extra = {}) => ({ x, y, z, w, h, d, color, ...extra });

export function arcadeDef() {
  const R = BRAND.primary, K = BRAND.dark;
  return {
    kind: "arcade-cabinet",
    label: "arcade cabinet",
    footprint: { w: 1, d: 1 },
    screen: true,
    boxes: [
      box(2, 0, 1, 12, 13, 12, K),
      box(1, 0, 0, 1, 30, 15, R), box(14, 0, 0, 1, 30, 15, R),
      box(2, 13, 1, 12, 14, 9, K),
      box(3, 17, 10, 10, 8, 1, "#0d0d0d"),
      box(4, 18, 11, 8, 6, 1, "#ffffff", { material: "screen" }),
      box(2, 12, 11, 12, 3, 5, "#2b2b2b"),
      box(4, 15, 13, 2, 1, 2, "#ffd45c", { emissive: true }),
      box(9, 15, 12, 1, 1, 1, "#4fc3ff", { emissive: true }), box(11, 15, 13, 1, 1, 1, R, { emissive: true }),
      box(2, 27, 1, 12, 4, 11, K),
      box(3, 27, 12, 10, 3, 1, "#ffd45c", { emissive: true }),
      box(2, 0, 13, 12, 2, 2, R),
    ],
    stations: [{ x: 8, z: 26, rot: 180, activity: "play", duration: 40 }],
  };
}

export function brickWallDef() {
  // bricks 7×3 units with 1-unit mortar joints, offset every other course, in front of a mortar slab
  const tones = ["#b8432f", "#9e3524", "#c95a40", "#ad3f2c"];
  const boxes = [box(0, 0, 7, 48, 40, 2, "#d9cfc2")];
  for (let row = 0; row < 10; row++) {
    const y = row * 4;
    const starts = [];
    for (let x = row % 2 ? -4 : 0; x < 48; x += 8) starts.push(x);
    starts.forEach((x0, i) => {
      const a = Math.max(0, x0), b = Math.min(48, x0 + 7);
      if (b - a < 2) return;
      boxes.push(box(a, y, 5, b - a, 3, 6, tones[(row * 5 + i * 3) % tones.length]));
    });
  }
  boxes.push(box(0, 40, 4, 48, 2, 8, "#ece6dc"));
  return { kind: "brick-wall", label: "brick wall", footprint: { w: 3, d: 1 }, boxes };
}

export function coffeeBarDef() {
  const K = BRAND.dark, W = "#c99a68";
  return {
    kind: "coffee-bar",
    label: "coffee bar",
    footprint: { w: 2, d: 1 },
    boxes: [
      box(0, 0, 2, 32, 14, 12, K),
      box(0, 14, 1, 32, 2, 14, W),
      box(2, 2, 14, 28, 1, 1, BRAND.primary, { emissive: true }),
      box(3, 16, 4, 9, 11, 8, "#d9d9d9", { material: "glossy" }),
      box(4, 16, 11, 7, 4, 2, "#2b2b2b"),
      box(5, 24, 12, 2, 1, 1, "#8dffb5", { emissive: true }),
      box(14, 16, 6, 3, 3, 3, "#fdfaf3"), box(18, 16, 6, 3, 3, 3, BRAND.primary),
      box(23, 16, 3, 6, 9, 6, "#ffffff", { material: "glass" }),
      box(24, 16, 4, 4, 5, 4, "#6b4630"),
    ],
    stations: [{ x: 8, z: 26, rot: 180, activity: "coffee" }, { x: 24, z: 26, rot: 180, activity: "snack" }],
  };
}

export function huddleDef() {
  const W = "#e8e2d8", K = BRAND.dark;
  return {
    kind: "huddle-table",
    label: "huddle table",
    footprint: { w: 2, d: 2 },
    boxes: [
      box(13, 0, 13, 6, 1, 6, K), box(15, 1, 15, 2, 10, 2, K),
      box(6, 10, 4, 20, 2, 24, W), box(4, 10, 6, 24, 2, 20, W), box(5, 9, 5, 22, 1, 22, BRAND.primary),
      box(8, 12, 9, 4, 1, 3, "#ffffff"), box(20, 12, 18, 3, 3, 3, BRAND.primary),
    ],
    stations: [
      { x: -6, z: 16, rot: 90, activity: "chat" }, { x: 38, z: 16, rot: 270, activity: "chat" },
      { x: 16, z: -6, rot: 0, activity: "chat" }, { x: 16, z: 38, rot: 180, activity: "think" },
    ],
  };
}

/** A 256×256 PNG logo drawn on a canvas: a flame mark on a rounded square. Resolves {blob, w, h}. */
export function drawLogo() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = BRAND.primary;
  g.beginPath();
  g.roundRect(16, 16, 224, 224, 48);
  g.fill();
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.moveTo(128, 46);
  g.bezierCurveTo(176, 96, 196, 130, 186, 168);
  g.bezierCurveTo(176, 204, 146, 214, 128, 214);
  g.bezierCurveTo(98, 214, 70, 196, 70, 160);
  g.bezierCurveTo(70, 130, 92, 110, 104, 92);
  g.bezierCurveTo(108, 118, 118, 128, 130, 132);
  g.bezierCurveTo(132, 104, 128, 76, 128, 46);
  g.fill();
  g.fillStyle = BRAND.dark;
  g.beginPath();
  g.ellipse(130, 178, 22, 26, 0, 0, Math.PI * 2);
  g.fill();
  return new Promise((resolve, reject) => c.toBlob((blob) => (blob ? resolve({ blob, w: 256, h: 256 }) : reject(new Error("canvas.toBlob gave nothing"))), "image/png"));
}
