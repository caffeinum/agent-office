// Dimmed theme zones and kind lights in the shader. A zone multiplies the room's own light (ambient, hemisphere,
// sun and the lamp/ceiling point lights) by tint × (1 − dim) inside its rectangle, with a soft half-cell edge;
// custom kinds' point lights (uPointExempt = 1) and unlit glowing materials stay at full strength, so a dimmed
// corner keeps its neon spill. Every lit material passes through withZones once.

import * as THREE from "three";
import { POINT_LIGHTS_GL, ZONE_PARS, ZONES_GL, zonedLightsChunk } from "./zone-glsl.js";

export { POINT_LIGHTS_GL, ZONES_GL };

export const zoneUniforms = {
  uZoneRect: { value: Array.from({ length: ZONES_GL }, () => new THREE.Vector4()) },
  uZoneTint: { value: Array.from({ length: ZONES_GL }, () => new THREE.Vector4(1, 1, 1, 0)) },
  uZoneCount: { value: 0 },
  uPointExempt: { value: new Float32Array(POINT_LIGHTS_GL) },
};

/** Theme zones [{x, z, w, d, tint, dim}] (cells, the world frame) → the shared uniforms. */
export function setZones(zones) {
  if (zones.length > ZONES_GL) throw new Error(`${zones.length} zones, the shader holds ${ZONES_GL}`);
  const c = new THREE.Color();
  zones.forEach((z, i) => {
    zoneUniforms.uZoneRect.value[i].set(z.x, z.z, z.w, z.d);
    c.set(z.tint);
    zoneUniforms.uZoneTint.value[i].set(c.r, c.g, c.b, z.dim);
  });
  zoneUniforms.uZoneCount.value = zones.length;
}

/** Which point lights (in the renderer's order: the scene's visible point lights as added) skip zone dimming. */
export function setPointExempt(flags) {
  if (flags.length > POINT_LIGHTS_GL) throw new Error(`${flags.length} point lights, the shader holds ${POINT_LIGHTS_GL}`);
  zoneUniforms.uPointExempt.value.fill(0);
  flags.forEach((f, i) => { zoneUniforms.uPointExempt.value[i] = f ? 1 : 0; });
}

let lightsChunk = null;

/** Hooks a lit (MeshStandard) material into the zones; keeps any onBeforeCompile it already has. */
export function withZones(m) {
  if (m.userData.zoned) return m;
  m.userData.zoned = true;
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (sh, renderer) => {
    prev.call(m, sh, renderer);
    lightsChunk ??= zonedLightsChunk(THREE.ShaderChunk.lights_fragment_begin);
    Object.assign(sh.uniforms, zoneUniforms);
    const need = (src, s) => { if (!src.includes(s)) throw new Error(`zone shader: no "${s}" in ${m.type}`); };
    need(sh.vertexShader, "#include <common>");
    need(sh.vertexShader, "#include <project_vertex>");
    need(sh.fragmentShader, "#include <common>");
    need(sh.fragmentShader, "#include <lights_fragment_begin>");
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vZoneWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\n{\n  vec4 zw = vec4( transformed, 1.0 );\n  #ifdef USE_INSTANCING\n  zw = instanceMatrix * zw;\n  #endif\n  vZoneWorld = ( modelMatrix * zw ).xyz;\n}");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${ZONE_PARS}`)
      .replace("#include <lights_fragment_begin>", lightsChunk);
  };
  m.customProgramCacheKey = () => `${prevKey()}|zones`;
  m.needsUpdate = true;
  return m;
}
