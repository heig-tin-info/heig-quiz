/**
 * The search of the public pool catalogue (ADR-095): what a typed query
 * becomes before it meets the database. Pure (invariant 8): the API turns each
 * term into an `ILIKE` over the pool's name, description, domain and concept
 * labels, with no extension (`pg_trgm` is absent from PGlite).
 */
import { conceptKey, foldText } from "./concepts.js";
import { similarityTerms } from "./similarityTerms.js";

/** One term of a query: its folded form, and the key a concept of that name has (`conceptKey`, plural dropped). */
export interface CatalogueTerm {
  folded: string;
  key: string;
}

/** The longest query read, and the most terms kept. */
export const CATALOGUE_QUERY_MAX = 100;
const MAX_TERMS = 8;

/**
 * The terms of a query, every one of which a pool must match (anywhere).
 * The words come from `similarityTerms` (ADR-081's list of words worth
 * matching: no stop words); a query made only of short or stop words
 * ("IA", "C") is taken whole rather than matching everything.
 */
export function catalogueTerms(query: string): CatalogueTerm[] {
  const text = query.trim().slice(0, CATALOGUE_QUERY_MAX);
  const words = similarityTerms(text, MAX_TERMS);
  const wanted = words.length > 0 ? words : text === "" ? [] : [text.toLowerCase().replace(/\s+/g, " ")];
  return wanted.map((word) => ({ folded: foldText(word), key: conceptKey(word) }));
}

/** The longest domain label of a pool, in characters, per language. */
export const POOL_DOMAIN_MAX = 40;

/** The share of the day's LLM cap the night's domain pass may spend: a few tiny calls (ADR-095, ADR-060 section 5). */
export const LLM_DOMAIN_NIGHT_SHARE = 0.05;
