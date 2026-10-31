// W5 (spec-v2 §7.6): pure place resolver over places.json. W1 stub with the final signature; W5 owns this file from
// the W1 merge.
import type { CompanySite, Place, PlacesDoc } from "../../public/shared/city.js";

export interface PlaceContext {
  places: PlacesDoc;
  /** companies.json sites: street-number addresses ("501 2nd St") resolve through these */
  sites: readonly CompanySite[];
}

/** Unknown or ambiguous query: carries up to 5 closest candidates (the tool answers 400 with them). */
export class PlaceError extends Error {
  readonly candidates: readonly Place[];
  constructor(message: string, candidates: readonly Place[]) {
    super(message);
    this.name = "PlaceError";
    this.candidates = candidates;
  }
}

/**
 * Name, alias, "A & B" / "A and B" / "A at B" intersection, or street address → exactly one place.
 * Throws PlaceError on no match or ambiguity. Agent names, {lat, lon} and inside/outside are the City DO's job.
 */
export function resolvePlace(query: string, ctx: PlaceContext): Place {
  throw new Error("resolvePlace: not implemented yet (W5, spec-v2 §7.6)");
}
