// W5 (spec-v2 §7.6): pure place resolver over places.json. Agent names, {lat, lon} and inside/outside are the City
// DO's job; this resolves names, aliases, intersections and street addresses to exactly one place, or throws.
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

export const MAX_CANDIDATES = 5;

const SUFFIX: Readonly<Record<string, string>> = {
  street: "st", str: "st", avenue: "ave", av: "ave", boulevard: "blvd", drive: "dr", place: "pl", lane: "ln",
  road: "rd", court: "ct", terrace: "ter", plaza: "plz",
};
const SUFFIX_FORMS = new Set(["st", "ave", "blvd", "dr", "pl", "ln", "rd", "ct", "ter", "plz", "way", "aly"]);
const ORDINAL: Readonly<Record<string, string>> = {
  first: "1st", second: "2nd", third: "3rd", fourth: "4th", fifth: "5th", sixth: "6th", seventh: "7th", eighth: "8th",
  ninth: "9th", tenth: "10th", eleventh: "11th", twelfth: "12th",
};
const KIND_RANK: Readonly<Record<Place["kind"], number>> = { landmark: 0, area: 1, company: 2, intersection: 3 };

/** Lowercase, no accents or punctuation, "&" spaced, no leading "the", suffixes and ordinals in one spelling. */
export function canonical(s: string): string {
  const words = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/&/g, " & ")
    .replace(/[^a-z0-9&]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words[0] === "the" && words.length > 1) words.shift();
  return words.map((w) => SUFFIX[w] ?? ORDINAL[w] ?? w).join(" ");
}

/** Canonical street without its suffix: "2nd st" → "2nd". */
const streetBase = (c: string): string => {
  const w = c.split(" ");
  return w.length > 1 && SUFFIX_FORMS.has(w[w.length - 1]!) ? w.slice(0, -1).join(" ") : c;
};
const streetMatches = (queryPart: string, street: string): boolean => street === queryPart || streetBase(street) === queryPart;

interface Indexed {
  place: Place;
  forms: string[];
  tokens: Set<string>;
  /** intersections: the two canonical street names */
  streets: [string, string] | null;
}

const indexCache = new WeakMap<PlacesDoc, Indexed[]>();

function indexOf(doc: PlacesDoc): Indexed[] {
  const hit = indexCache.get(doc);
  if (hit) return hit;
  if (!doc || !Array.isArray(doc.places)) throw new Error("resolvePlace: ctx.places must be a places.json document");
  const idx = doc.places.map((place) => {
    const forms = [place.name, ...place.aliases].map(canonical);
    let streets: [string, string] | null = null;
    if (place.kind === "intersection") {
      const parts = place.name.split(" & ");
      if (parts.length !== 2) throw new Error(`places: intersection ${place.id} is not named "A & B"`);
      streets = [canonical(parts[0]!), canonical(parts[1]!)];
    }
    return { place, forms, tokens: new Set(forms.flatMap((f) => f.split(" "))), streets };
  });
  indexCache.set(doc, idx);
  return idx;
}

const rank = (a: Place, b: Place): number => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.name.length - b.name.length || (a.id < b.id ? -1 : 1);

/** Character-bigram Dice similarity, for "did you mean" candidates. */
function similarity(a: string, b: string): number {
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const [ga, gb] = [grams(a), grams(b)];
  let common = 0;
  for (const [g, n] of ga) common += Math.min(n, gb.get(g) ?? 0);
  const total = Math.max(1, a.length - 1) + Math.max(1, b.length - 1);
  return (2 * common) / total;
}

/** One match wins; several company sites of one company resolve to its primary site; otherwise ambiguous. */
function pick(query: string, matches: Place[], ctx: PlaceContext): Place {
  const unique = [...new Map(matches.map((p) => [p.id, p])).values()];
  if (unique.length === 1) return unique[0]!;
  if (unique.every((p) => p.kind === "company")) {
    const sites = unique.map((p) => {
      const s = ctx.sites.find((x) => x.id === p.siteId);
      if (!s) throw new Error(`resolvePlace: place ${p.id} names site ${p.siteId}, which is not in ctx.sites`);
      return s;
    });
    const primaries = unique.filter((_, i) => sites[i]!.primary);
    if (new Set(sites.map((s) => s.companyId)).size === 1 && primaries.length === 1) return primaries[0]!;
  }
  const candidates = unique.sort(rank).slice(0, MAX_CANDIDATES);
  throw new PlaceError(`"${query}" is ambiguous: ${unique.length} places match (${candidates.map((p) => p.name).join("; ")})`, candidates);
}

/**
 * Name, alias, "A & B" / "A and B" / "A at B" intersection, or street address → exactly one place.
 * Throws PlaceError on no match or ambiguity. Agent names, {lat, lon} and inside/outside are the City DO's job.
 */
export function resolvePlace(query: string, ctx: PlaceContext): Place {
  if (typeof query !== "string" || query.trim() === "") throw new PlaceError("empty place query", []);
  const idx = indexOf(ctx.places);
  const q = canonical(query);
  if (q === "") throw new PlaceError(`"${query}" has no letters or digits`, []);

  const exact = idx.filter((p) => p.forms.includes(q)).map((p) => p.place);
  if (exact.length) return pick(query, exact, ctx);

  const parts = q.split(/ (?:&|and|at) /);
  if (parts.length === 2 && parts[0] && parts[1]) {
    const [a, b] = parts as [string, string];
    const hits = idx
      .filter((p) => p.streets && ((streetMatches(a, p.streets[0]) && streetMatches(b, p.streets[1])) || (streetMatches(b, p.streets[0]) && streetMatches(a, p.streets[1]))))
      .map((p) => p.place);
    if (hits.length) return pick(query, hits, ctx);
  }

  const addr = /^(\d+[a-z]?) (.+)$/.exec(q);
  if (addr) {
    const [, num, street] = addr as unknown as [string, string, string];
    const siteIds = new Set(
      ctx.sites
        .filter((s) => {
          const a = /^(\d+[a-z]?) (.+)$/.exec(canonical(s.address.split(",")[0]!));
          return a !== null && a[1] === num && streetMatches(street, a[2]!);
        })
        .map((s) => s.id),
    );
    const hits = idx.filter((p) => p.place.kind === "company" && p.place.siteId !== undefined && siteIds.has(p.place.siteId)).map((p) => p.place);
    if (hits.length) return pick(query, hits, ctx);
  }

  const words = q.split(" ").filter((w) => w !== "&");
  const partial = idx.filter((p) => words.every((w) => p.tokens.has(w))).map((p) => p.place);
  if (partial.length) return pick(query, partial, ctx);

  const closest = idx
    .map((p) => ({ p: p.place, s: Math.max(...p.forms.map((f) => similarity(q, f))) }))
    .sort((a, b) => b.s - a.s || rank(a.p, b.p))
    .slice(0, MAX_CANDIDATES)
    .map((c) => c.p);
  throw new PlaceError(`unknown place "${query}"`, closest);
}
