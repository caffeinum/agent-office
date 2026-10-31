// North arrow (spec-v2 §1.1: mandatory when rotDeg ≠ 0). The map is a rigid rotation of lon/lat, so north is
// one fixed direction in block space; the needle shows where it points on screen for the orbit camera's azimuth.
// Rendered into a container W7 provides (#city-compass). Pure maths are exported for checks.
import { blockToLonLat, lonLatToBlock } from "../../shared/city.js";

/** Pure. Unit vector {x, z} in block space pointing true north, for this projection. */
export function northVector(proj) {
  const x = proj.x0, z = proj.z0;
  const ll = blockToLonLat(x, z, proj);
  const p = lonLatToBlock(ll.lon, ll.lat + 0.01, proj);
  const dx = p.x - x, dz = p.z - z;
  const len = Math.hypot(dx, dz);
  if (!(len > 0)) throw new Error("northVector: projection has no north direction");
  return { x: dx / len, z: dz / len };
}

/**
 * Pure. Clockwise screen angle (degrees, 0 = up) of `north` for an orbit camera at azimuth `az` (THREE Spherical
 * theta: the camera sits at target + (sin az, ·, cos az)·r and looks back at the target).
 */
export function screenNorthDeg(north, az) {
  const fx = -Math.sin(az), fz = -Math.cos(az);
  const rx = Math.cos(az), rz = -Math.sin(az);
  const up = north.x * fx + north.z * fz;
  const right = north.x * rx + north.z * rz;
  return (Math.atan2(right, up) * 180) / Math.PI;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** → {update(az), destroy(), el}. Draws the needle in `container`; update() rotates it (cheap, skips < 0.2°). */
export function mountCompass(container, proj) {
  if (!container || typeof container.appendChild !== "function") throw new Error("mountCompass: container element required");
  const north = northVector(proj);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "-20 -20 40 40");
  svg.setAttribute("width", "40");
  svg.setAttribute("height", "40");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "north");
  svg.classList.add("city-compass");
  svg.style.cssText = "display:block;pointer-events:none";
  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("r", "18");
  ring.setAttribute("fill", "rgba(255,255,255,.85)");
  ring.setAttribute("stroke", "rgba(0,0,0,.35)");
  ring.setAttribute("stroke-width", "1.5");
  const needle = document.createElementNS(SVG_NS, "g");
  const up = document.createElementNS(SVG_NS, "polygon");
  up.setAttribute("points", "0,-15 5,0 -5,0");
  up.setAttribute("fill", "#c0362c");
  const down = document.createElementNS(SVG_NS, "polygon");
  down.setAttribute("points", "0,15 5,0 -5,0");
  down.setAttribute("fill", "#5b5f66");
  const label = document.createElementNS(SVG_NS, "text");
  label.setAttribute("x", "0");
  label.setAttribute("y", "-5");
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("font-size", "7");
  label.setAttribute("font-weight", "700");
  label.setAttribute("font-family", "system-ui, sans-serif");
  label.setAttribute("fill", "#fff");
  label.textContent = "N";
  needle.append(up, down, label);
  svg.append(ring, needle);
  container.appendChild(svg);
  let last = NaN;
  return {
    el: svg,
    north,
    update(az) {
      const deg = screenNorthDeg(north, az);
      if (Math.abs(deg - last) < 0.2) return deg;
      last = deg;
      needle.setAttribute("transform", `rotate(${deg.toFixed(1)})`);
      return deg;
    },
    destroy() { svg.remove(); },
  };
}
