import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module without types
import * as THREE from "../public/vendor/three-0.186.1/three.module.js";
// @ts-expect-error plain JS module without types
import { hueColors } from "../public/js/model.js";

describe("viewer colours", () => {
  it("every persona colour is one three.js can parse (it keeps the previous colour on a string it can't read)", () => {
    for (let hue = 0; hue < 360; hue += 23) {
      for (const [key, css] of Object.entries(hueColors(hue) as Record<string, string>)) {
        const probe = new THREE.Color("#010203").set(css);
        expect(probe.getHexString(), `${key} for hue ${hue}: ${css}`).not.toBe("010203");
      }
    }
  });
});
