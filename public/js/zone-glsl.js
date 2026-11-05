// The GLSL behind dimmed zones (zone-shader.js), pure strings so node checks can patch three's real chunk.

export const ZONES_GL = 8;
/** Point lights the exemption flags cover; scene.js caps lamp + fill + kind lights below this. */
export const POINT_LIGHTS_GL = 32;

export const ZONE_PARS = `
varying vec3 vZoneWorld;
uniform vec4 uZoneRect[ ${ZONES_GL} ];
uniform vec4 uZoneTint[ ${ZONES_GL} ];
uniform int uZoneCount;
uniform float uPointExempt[ ${POINT_LIGHTS_GL} ];
vec3 zoneLight( vec3 p ) {
  vec3 l = vec3( 1.0 );
  for ( int i = 0; i < ${ZONES_GL}; i ++ ) {
    if ( i >= uZoneCount ) break;
    vec4 r = uZoneRect[ i ];
    vec2 o2 = max( r.xy - p.xz, p.xz - ( r.xy + r.zw ) );
    float inside = 1.0 - smoothstep( -0.35, 0.35, max( o2.x, o2.y ) );
    l *= mix( vec3( 1.0 ), uZoneTint[ i ].rgb * ( 1.0 - uZoneTint[ i ].a ), inside );
  }
  return l;
}
`;

/** [needle, replacement] edits to three's lights_fragment_begin; each must match exactly once. */
const LIGHT_EDITS = [
  ["getPointLightInfo( pointLight, geometryPosition, directLight );", "getPointLightInfo( pointLight, geometryPosition, directLight );\n\t\tdirectLight.color *= mix( zoneL, vec3( 1.0 ), uPointExempt[ i ] );"],
  ["getDirectionalLightInfo( directionalLight, directLight );", "getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= zoneL;"],
  ["getSunLightInfo( sunLight, directLight );", "getSunLightInfo( sunLight, directLight );\n\t\tdirectLight.color *= zoneL;"],
  ["vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );", "vec3 irradiance = zoneL * getAmbientLightIrradiance( ambientLightColor );"],
  ["irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );", "irradiance += zoneL * getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );"],
];

/** three's lights_fragment_begin with the room's light scaled by zoneL (kind lights exempt). Throws if three changed. */
export function zonedLightsChunk(chunk) {
  let out = chunk;
  for (const [needle, repl] of LIGHT_EDITS) {
    const n = out.split(needle).length - 1;
    if (n !== 1) throw new Error(`zone shader: three's lights_fragment_begin has ${n} copies of "${needle}" (expected 1); three.js changed`);
    out = out.replace(needle, repl);
  }
  return `vec3 zoneL = zoneLight( vZoneWorld );\n${out}`;
}
