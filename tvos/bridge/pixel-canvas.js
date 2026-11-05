// A tiny software canvas for textures.js in JavaScriptCore: fillRect with a solid colour or a vertical linear
// gradient, which is all the voxel textures use. Anything else throws, so a texture that needs more is noticed
// rather than painted wrong.

function parse(style) {
  let m = /^#([0-9a-f]{6})$/i.exec(style);
  if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(style);
  if (m) return [+m[1], +m[2], +m[3]];
  throw new Error(`pixel-canvas: unsupported fillStyle ${JSON.stringify(style)}`);
}

/** A vertical gradient: colour at pixel row y (sampled at its centre), interpolated in sRGB like a 2D canvas. */
function verticalGradient(y0, y1) {
  const stops = [];
  return {
    addColorStop(at, color) { stops.push([at, parse(color)]); stops.sort((a, b) => a[0] - b[0]); },
    at(y) {
      const t = Math.max(0, Math.min(1, (y + 0.5 - y0) / (y1 - y0)));
      if (t <= stops[0][0]) return stops[0][1];
      for (let i = 1; i < stops.length; i++) {
        const [b, cb] = stops[i], [a, ca] = stops[i - 1];
        if (t <= b) { const k = (t - a) / (b - a); return ca.map((v, c) => Math.round(v + (cb[c] - v) * k)); }
      }
      return stops[stops.length - 1][1];
    },
  };
}

export function pixelCanvas(w, h) {
  const px = new Uint8Array(w * h * 3);
  let fill = [0, 0, 0];
  const ctx = {
    set fillStyle(s) { fill = typeof s === "string" ? parse(s) : s; },
    get fillStyle() { return fill; },
    createLinearGradient(x0, y0, x1, y1) {
      if (x0 !== x1) throw new Error("pixel-canvas: only vertical gradients are supported");
      return verticalGradient(y0, y1);
    },
    fillRect(x, y, rw, rh) {
      for (let j = Math.max(0, y); j < Math.min(h, y + rh); j++) {
        const c = Array.isArray(fill) ? fill : fill.at(j);
        for (let i = Math.max(0, x); i < Math.min(w, x + rw); i++) px.set(c, (j * w + i) * 3);
      }
    },
  };
  return {
    width: w, height: h, pixels: px,
    getContext(kind) { if (kind !== "2d") throw new Error(`pixel-canvas: no ${kind} context`); return ctx; },
  };
}

/** Installs document.createElement("canvas") for textures.js. */
export function installDocument() {
  globalThis.document = {
    createElement(tag) {
      if (tag !== "canvas") throw new Error(`pixel-canvas: document.createElement(${tag}) is not available`);
      const c = { _w: 0, _h: 0, _real: null };
      return new Proxy(c, {
        set(t, k, v) {
          if (k === "width") t._w = v; else if (k === "height") t._h = v; else t[k] = v;
          return true;
        },
        get(t, k) {
          if (k === "getContext") return (kind) => { t._real ??= pixelCanvas(t._w, t._h); return t._real.getContext(kind); };
          if (k === "width") return t._w;
          if (k === "height") return t._h;
          if (k === "pixels") return t._real?.pixels;
          return t[k];
        },
      });
    },
  };
}
