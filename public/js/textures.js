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

/* ── themed surfaces: greyscale patterns tinted by the material colour, so colours crossfade smoothly ── */

function grey(g, x, y, v) {
  const k = Math.round(255 * Math.max(0, Math.min(1, v)));
  g.fillStyle = `rgb(${k},${k},${k})`;
  g.fillRect(x, y, 1, 1);
}

/** Floor tile for one cell (16×16): wood planks, square tiles with grout, poured concrete or carpet. */
export function floorTexture(material) {
  const [c, g] = canvas(16, 16);
  const r = rng({ wood: 11, tile: 13, concrete: 17, carpet: 19 }[material] ?? 23);
  if (material === "wood") {
    const tone = [0.98, 0.9, 1.02, 0.93];
    for (let p = 0; p < 4; p++) {
      for (let y = p * 4; y < p * 4 + 4; y++) for (let x = 0; x < 16; x++) grey(g, x, y, tone[p] * (0.95 + r() * 0.06) - (y === p * 4 + 3 ? 0.1 : 0));
      const seam = (p * 7 + 3) % 16;
      for (let y = p * 4; y < p * 4 + 4; y++) grey(g, seam, y, tone[p] * 0.7);
      if (r() < 0.6) { const x = Math.floor(r() * 14); grey(g, x, p * 4 + 1, tone[p] * 0.8); grey(g, x + 1, p * 4 + 1, tone[p] * 0.8); }
    }
  } else if (material === "tile") {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const grout = x % 8 === 7 || y % 8 === 7;
      const which = ((x >> 3) + (y >> 3)) % 2;
      const edge = x % 8 === 0 || y % 8 === 0;
      grey(g, x, y, grout ? 0.66 : (which ? 0.97 : 0.92) * (edge ? 1.04 : 1) * (0.98 + r() * 0.03));
    }
  } else if (material === "concrete") {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      let v = 0.95 + r() * 0.05;
      if (r() < 0.05) v -= 0.12;
      if (r() < 0.03) v += 0.08;
      grey(g, x, y, v);
    }
    for (let x = 0; x < 16; x++) grey(g, x, 15, 0.8);
  } else if (material === "carpet") {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const loop = (x + y) % 4 === 0 ? 0.04 : 0;
      grey(g, x, y, 0.91 + r() * 0.06 + loop);
    }
  } else throw new Error(`floorTexture: unknown material ${JSON.stringify(material)}`);
  return tex(c, { repeat: true });
}

/** Wall surface, one tile per world unit: plaster, brick (4 courses, offset joints) or vertical wood-panels. */
export function wallTexture(material) {
  const [c, g] = canvas(16, 16);
  const r = rng({ plaster: 29, brick: 31, "wood-panels": 37 }[material] ?? 41);
  if (material === "plaster") {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) grey(g, x, y, 0.93 + r() * 0.07);
  } else if (material === "brick") {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const course = y >> 2;
      const mortar = y % 4 === 3 || (x + (course % 2) * 4) % 8 === 7;
      const brickId = course * 2 + (((x + (course % 2) * 4) >> 3) & 1);
      const tone = 0.78 + ((brickId * 37) % 11) / 60;
      grey(g, x, y, mortar ? 1.12 + r() * 0.04 : tone * (0.94 + r() * 0.08));
    }
  } else if (material === "wood-panels") {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const panel = x >> 2;
      const groove = x % 4 === 3;
      grey(g, x, y, groove ? 0.62 : [0.95, 0.88, 0.99, 0.91][panel] * (0.96 + r() * 0.06));
    }
  } else throw new Error(`wallTexture: unknown material ${JSON.stringify(material)}`);
  return tex(c, { repeat: true });
}

/** Night window variants: stars, a city skyline, a calm aurora, or rain on the glass. */
export function nightWindowTexture(style) {
  if (style === "stars" || !style) return windowTexture(true);
  const [c, g] = canvas(32, 16);
  const r = rng({ city: 79, aurora: 83, rain: 89 }[style] ?? 97);
  const grad = g.createLinearGradient(0, 0, 0, 16);
  if (style === "city") {
    grad.addColorStop(0, "#151a36"); grad.addColorStop(1, "#3b2f58");
    g.fillStyle = grad; g.fillRect(0, 0, 32, 16);
    let x = 0;
    while (x < 32) {
      const w = 3 + Math.floor(r() * 4), h = 5 + Math.floor(r() * 9);
      g.fillStyle = r() < 0.5 ? "#232849" : "#1b1f3c";
      g.fillRect(x, 16 - h, w, h);
      for (let wy = 17 - h; wy < 15; wy += 2) for (let wx = x + 1; wx < x + w - 1; wx += 2) if (r() < 0.45) { g.fillStyle = r() < 0.7 ? "#ffd27a" : "#9fd0ff"; g.fillRect(wx, wy, 1, 1); }
      x += w;
    }
  } else if (style === "aurora") {
    grad.addColorStop(0, "#0b1430"); grad.addColorStop(1, "#16284a");
    g.fillStyle = grad; g.fillRect(0, 0, 32, 16);
    for (let x = 0; x < 32; x++) {
      const y = 5 + Math.round(Math.sin(x * 0.4) * 2 + Math.sin(x * 0.13) * 1.5);
      g.fillStyle = "#4fe3a8"; g.fillRect(x, y, 1, 2);
      g.fillStyle = "rgba(140, 120, 255, 0.7)"; g.fillRect(x, y - 2, 1, 2);
    }
    for (let i = 0; i < 10; i++) { g.fillStyle = "#cfd8ff"; g.fillRect(Math.floor(r() * 32), Math.floor(r() * 4), 1, 1); }
    g.fillStyle = "#1d2b3d"; g.fillRect(0, 13, 32, 3);
  } else if (style === "rain") {
    grad.addColorStop(0, "#1a2236"); grad.addColorStop(1, "#2c3650");
    g.fillStyle = grad; g.fillRect(0, 0, 32, 16);
    g.fillStyle = "#232c44"; g.fillRect(0, 11, 32, 5);
    for (let x = 1; x < 32; x += 5) if (r() < 0.7) { g.fillStyle = "#ffd27a"; g.fillRect(x, 12 + Math.floor(r() * 3), 1, 1); }
    for (let i = 0; i < 26; i++) { g.fillStyle = r() < 0.5 ? "rgba(170, 200, 240, 0.75)" : "rgba(120, 150, 200, 0.6)"; g.fillRect(Math.floor(r() * 32), Math.floor(r() * 15), 1, 2); }
  } else {
    // unknown style: a plain night sky rather than a guess
    grad.addColorStop(0, "#141a3a"); grad.addColorStop(1, "#2b2f5e");
    g.fillStyle = grad; g.fillRect(0, 0, 32, 16);
  }
  return tex(c);
}

/** A screen showing the office logo, letterboxed on a dark panel (aspect = w / h). Linear-filtered so it stays crisp. */
export function logoScreenTexture(img, { w = 512, h = 288, bg = "#141414", fit = 0.72 } = {}) {
  const [c, g] = canvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const iw = img.width, ih = img.height;
  const s = Math.min((w * fit) / iw, (h * fit) / ih);
  const dw = iw * s, dh = ih * s;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  return t;
}

/** A sign panel with the office logo on top and (if any) the text underneath. */
export function logoTextTexture(img, text, { bg, fg, w = 256, h = 160 }) {
  const [c, g] = canvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  const hasText = !!String(text || "").trim();
  const box = { w: w * 0.8, h: h * (hasText ? 0.5 : 0.78) };
  const s = Math.min(box.w / img.width, box.h / img.height);
  const dw = img.width * s, dh = img.height * s;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, (w - dw) / 2, hasText ? h * 0.08 + (box.h - dh) / 2 : (h - dh) / 2, dw, dh);
  if (hasText) {
    g.fillStyle = fg;
    g.textBaseline = "middle";
    let size = Math.round(h * 0.16);
    const line = String(text).replace(/\s+/g, " ").trim();
    do { g.font = `700 ${size}px ui-rounded, "SF Pro Rounded", system-ui, sans-serif`; size -= 2; } while (g.measureText(line).width > w * 0.88 && size > 8);
    g.fillText(line, (w - Math.min(g.measureText(line).width, w * 0.9)) / 2, h * 0.78, w * 0.9);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
