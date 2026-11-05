// furniture/model/character import three only for geometry builders the TV never calls. textures.js needs a little
// more: Color for shading and CanvasTexture to hand back the painted canvas, which pixel-canvas.js provides.
// Like three's Color with colour management on, hex in/out is sRGB and the maths runs in linear light.

const toLinear = (c) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));
const toSRGB = (c) => (c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055);

export class Color {
  constructor(hex) { this.r = 0; this.g = 0; this.b = 0; if (hex !== undefined) this.set(hex); }
  set(hex) {
    const hsl = /^hsl\(\s*(\d*\.?\d+)\s*,\s*(\d*\.?\d+)%\s*,\s*(\d*\.?\d+)%\s*\)$/.exec(hex);
    if (hsl) return this.setHSL(+hsl[1] / 360, +hsl[2] / 100, +hsl[3] / 100);
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) throw new Error(`three-stub Color: only #rrggbb and hsl(h, s%, l%) are supported, got ${JSON.stringify(hex)}`);
    const n = parseInt(m[1], 16);
    this.r = toLinear((n >> 16) / 255); this.g = toLinear(((n >> 8) & 255) / 255); this.b = toLinear((n & 255) / 255);
    return this;
  }
  setHSL(h, s, l) {
    h = ((h % 1) + 1) % 1;
    const q = l <= 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const hue = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
      return p;
    };
    this.r = toLinear(hue(h + 1 / 3)); this.g = toLinear(hue(h)); this.b = toLinear(hue(h - 1 / 3));
    return this;
  }
  multiplyScalar(f) { this.r *= f; this.g *= f; this.b *= f; return this; }
  getHexString() {
    const h = (v) => Math.round(Math.max(0, Math.min(1, toSRGB(v))) * 255).toString(16).padStart(2, "0");
    return h(this.r) + h(this.g) + h(this.b);
  }
}

/** voxel.js's buildGeometry output, kept as plain arrays for the Swift side. */
export class Float32BufferAttribute {
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
}
export class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; }
  setAttribute(name, attr) { this.attributes[name] = attr; }
  setIndex(idx) { this.index = idx; }
  computeBoundingSphere() {}
  computeBoundingBox() {}
}

export class CanvasTexture {
  constructor(canvas) { this.image = canvas; }
}

export const NearestFilter = 1003, NearestMipmapLinearFilter = 1005, RepeatWrapping = 1000, SRGBColorSpace = "srgb";
