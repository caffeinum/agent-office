// W3 (spec-v2 §4/§5): the global landmarks.bin mesh layer (Bay Bridge west span, Golden Gate south half,
// Salesforce crown lattice). W1 stub with the final signature; W3 owns this file from the W1 merge.
import { SF_GRID, encodeLandmarks } from "../../../public/shared/city.js";

/**
 * → raw SFL1 bytes (encodeLandmarks); build-sf gzips them into public/city/sf/landmarks.bin.
 * The stub returns an empty, valid mesh.
 */
export function buildLandmarkMesh(ctx) {
  return encodeLandmarks([], SF_GRID);
}
