// Our own procedural pixel textures: tiny canvases, NearestFilter, so every surface reads as chunky
// voxels. Seeded so every viewer paints the same office.

import * as THREE from "three";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return [c, c.getContext("2d")];
}

function tex(c, { repeat = false, srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.generateMipmaps = true;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 4;
  return t;
}

const shade = (hex, f) => {
  const c = new THREE.Color(hex);
  c.multiplyScalar(f);
  return `#${c.getHexString()}`;
};

/** Greyscale voxel grain for furniture: 16×16, mean ≈ 0.93 so vertex colours stay true. */
export function grainTexture() {
  const [c, g] = canvas(16, 16);
  const r = rng(7);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const v = Math.round(255 * (0.88 + r() * 0.12));
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(x, y, 1, 1);
  }
  return tex(c, { repeat: true });
}

/** Warm wood planks, one tile per cell: 16×16 px, 4 planks with staggered seams. */
export function woodTexture() {
  const [c, g] = canvas(16, 16);
  const r = rng(11);
  const base = ["#d9b086", "#d1a67b", "#ddb68e", "#cda278"];
  for (let p = 0; p < 4; p++) {
    for (let y = p * 4; y < p * 4 + 4; y++) for (let x = 0; x < 16; x++) {
      const f = 0.95 + r() * 0.07 - (y === p * 4 + 3 ? 0.1 : 0);
      g.fillStyle = shade(base[p], f);
      g.fillRect(x, y, 1, 1);
    }
    const seam = (p * 7 + 3) % 16;
    g.fillStyle = shade(base[p], 0.72);
    g.fillRect(seam, p * 4, 1, 4);
    if (r() < 0.6) { g.fillStyle = shade(base[p], 0.8); g.fillRect(Math.floor(r() * 16), p * 4 + 1, 2, 1); }
  }
  return tex(c, { repeat: true });
}

/** Soft plaster for the walls, with a darker band near the floor. */
export function plasterTexture() {
  const [c, g] = canvas(16, 16);
  const r = rng(23);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    g.fillStyle = shade("#f1e4cc", 0.94 + r() * 0.07);
    g.fillRect(x, y, 1, 1);
  }
  return tex(c, { repeat: true });
}

/** Grass top for the garden around the office. */
export function grassTexture() {
  const [c, g] = canvas(16, 16);
  const r = rng(31);
  const greens = ["#79b85a", "#6fae52", "#86c265", "#68a44c", "#8ccb6b"];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    g.fillStyle = greens[Math.floor(r() * greens.length)];
    g.fillRect(x, y, 1, 1);
  }
  return tex(c, { repeat: true });
}

/** Dressed-stone plinth for the island's sides: warm sandstone courses with offset joints and a darker cap line. */
export function plinthTexture() {
  const [c, g] = canvas(16, 16);
  const r = rng(37);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const course = y >> 2;
    const joint = y % 4 === 3 || (x + (course % 2) * 4) % 8 === 7;
    const cap = y < 2;
    const base = cap ? "#b9a892" : course % 2 ? "#d8c6a8" : "#cfbb9b";
    g.fillStyle = joint ? shade("#9c8a72", 0.95 + r() * 0.08) : shade(base, 0.93 + r() * 0.1);
    g.fillRect(x, y, 1, 1);
  }
  return tex(c, { repeat: true });
}

/** A rug weave: two-tone border, checker field. Tinted by vertex/instance colour. */
export function rugTexture() {
  const [c, g] = canvas(32, 48);
  const r = rng(41);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 32; x++) {
    const border = x < 2 || y < 2 || x > 29 || y > 45;
    const inner = x === 3 || y === 3 || x === 28 || y === 44;
    const check = ((x >> 2) + (y >> 2)) % 2 === 0;
    const v = border ? 0.62 : inner ? 1 : check ? 0.9 : 0.84;
    const n = v * (0.95 + r() * 0.06);
    const k = Math.round(255 * Math.min(1, n));
    g.fillStyle = `rgb(${k},${k},${k})`;
    g.fillRect(x, y, 1, 1);
  }
  return tex(c);
}

/** Monitor screen: dark editor with coloured code lines. */
export function screenTexture() {
  const [c, g] = canvas(32, 20);
  const r = rng(53);
  g.fillStyle = "#18233a";
  g.fillRect(0, 0, 32, 20);
  const cols = ["#7fd1ff", "#ffd479", "#b8f28a", "#ff9fb8", "#c9b6ff", "#e8eef8"];
  for (let y = 2; y < 18; y += 2) {
    let x = 2 + (r() < 0.5 ? 2 : 0) + (r() < 0.3 ? 2 : 0);
    while (x < 29) {
      const len = 2 + Math.floor(r() * 6);
      g.fillStyle = cols[Math.floor(r() * cols.length)];
      g.fillRect(x, y, Math.min(len, 30 - x), 1);
      x += len + 1;
      if (r() < 0.25) break;
    }
  }
  g.fillStyle = "#2b3a5c";
  g.fillRect(0, 0, 32, 1);
  return tex(c);
}

/** TV: a cheerful pixel dashboard. */
export function tvTexture() {
  const [c, g] = canvas(32, 18);
  g.fillStyle = "#1d2440";
  g.fillRect(0, 0, 32, 18);
  const bars = [5, 9, 7, 12, 10, 14, 11];
  bars.forEach((h, i) => {
    g.fillStyle = i % 2 ? "#ffb86b" : "#7ee0c3";
    g.fillRect(3 + i * 3, 16 - h, 2, h);
  });
  g.fillStyle = "#ff7a9c";
  g.fillRect(25, 3, 5, 5);
  g.fillStyle = "#ffe08a";
  g.fillRect(25, 10, 5, 2);
  g.fillRect(25, 13, 3, 2);
  return tex(c);
}

/** Server rack front: blinking-LED rows (static texture; the glow does the rest). */
export function rackTexture() {
  const [c, g] = canvas(16, 32);
  const r = rng(61);
  g.fillStyle = "#20232b";
  g.fillRect(0, 0, 16, 32);
  for (let y = 1; y < 31; y += 3) {
    g.fillStyle = "#2e323d";
    g.fillRect(1, y, 14, 2);
    g.fillStyle = r() < 0.5 ? "#6dffb0" : r() < 0.5 ? "#7fc8ff" : "#ffcf6b";
    g.fillRect(2, y, 1, 1);
    if (r() < 0.6) { g.fillStyle = "#6dffb0"; g.fillRect(4, y, 1, 1); }
  }
  return tex(c);
}

/** Window glass: a sky with pixel clouds by day, stars and a moon by night. */
export function windowTexture(night) {
  const [c, g] = canvas(32, 16);
  const r = rng(night ? 71 : 73);
  const grad = g.createLinearGradient(0, 0, 0, 16);
  if (night) { grad.addColorStop(0, "#141a3a"); grad.addColorStop(1, "#2b2f5e"); }
  else { grad.addColorStop(0, "#8fd0ff"); grad.addColorStop(1, "#d8f0ff"); }
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 16);
  if (night) {
    for (let i = 0; i < 14; i++) { g.fillStyle = r() < 0.3 ? "#fff6c8" : "#cfd8ff"; g.fillRect(Math.floor(r() * 32), Math.floor(r() * 11), 1, 1); }
    g.fillStyle = "#fff3c4"; g.fillRect(24, 3, 3, 3);
    g.fillStyle = "#2b2f5e"; g.fillRect(25, 3, 2, 1);
    g.fillStyle = "#3a3f73"; g.fillRect(0, 13, 32, 3);
    g.fillStyle = "#ffd27a";
    for (let x = 1; x < 32; x += 4) if (r() < 0.6) g.fillRect(x, 14, 1, 1);
  } else {
    g.fillStyle = "#ffffff";
    g.fillRect(4, 4, 6, 2); g.fillRect(6, 3, 3, 1);
    g.fillRect(18, 7, 8, 2); g.fillRect(20, 6, 4, 1);
    g.fillStyle = "#86c46a"; g.fillRect(0, 13, 32, 3);
    g.fillStyle = "#6aa955";
    for (let x = 0; x < 32; x += 3) g.fillRect(x, 12 + (x % 2), 2, 1);
  }
  return tex(c);
}

/** Sky gradient background (with stars at night). */
export function skyTexture(night) {
  const [c, g] = canvas(4, 256);
  const grad = g.createLinearGradient(0, 0, 0, 256);
  if (night) {
    grad.addColorStop(0, "#0d1026"); grad.addColorStop(0.6, "#1d2147"); grad.addColorStop(1, "#33305a");
  } else {
    grad.addColorStop(0, "#9fd3f5"); grad.addColorStop(0.55, "#d9eef7"); grad.addColorStop(1, "#fbe7cf");
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Soft round contact shadow (linear filtered: it's a blur, not a voxel). */
export function blobTexture() {
  const [c, g] = canvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, "rgba(40,28,20,0.55)");
  grad.addColorStop(0.6, "rgba(40,28,20,0.22)");
  grad.addColorStop(1, "rgba(40,28,20,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Text panel for signs, posters and the whiteboard: pixel-font-ish, wrapped, auto-sized. */
export function textTexture(text, { bg, fg, w = 128, h = 128, border = null }) {
  const [c, g] = canvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  if (border) { g.strokeStyle = border; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6); }
  g.fillStyle = fg;
  g.textBaseline = "top";
  const pad = 12;
  for (let size = 30; size >= 8; size -= 2) {
    g.font = `700 ${size}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`;
    const lines = [];
    for (const para of String(text || "").split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const tryLine = line ? `${line} ${word}` : word;
        if (g.measureText(tryLine).width > w - pad * 2 && line) { lines.push(line); line = word; } else line = tryLine;
      }
      lines.push(line);
    }
    const lh = size * 1.15;
    if (lines.length * lh <= h - pad * 2 || size === 8) {
      const y0 = (h - lines.length * lh) / 2;
      lines.forEach((ln, i) => g.fillText(ln, (w - g.measureText(ln).width) / 2, y0 + i * lh));
      break;
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
