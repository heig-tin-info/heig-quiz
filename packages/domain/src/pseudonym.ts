/**
 * Stable grid pseudonyms (F-DASH-02, decision D20).
 *
 * The dashboard can hide the students' names; each row then keeps an
 * adjective + animal label derived from `hashSeed(evaluationId, userId)`. It is
 * stable across reloads and identical in the dashboard and in the grading
 * panel, and it cannot be reversed without knowing the evaluation id.
 */
import { hashSeed, rng } from "@quiz/core/rng";

/** 48 x 48 = 2304 labels; `uniquePseudonyms` settles the remaining collisions. */
const ADJECTIVES = [
  "Agile", "Amber", "Ancient", "Bold", "Brave", "Bright", "Calm", "Clever",
  "Cosmic", "Curious", "Daring", "Eager", "Early", "Eastern", "Electric",
  "Elegant", "Fearless", "Fluent", "Frosty", "Gentle", "Gifted", "Golden",
  "Happy", "Humble", "Jolly", "Keen", "Lively", "Loyal", "Lucky", "Merry",
  "Mighty", "Noble", "Nimble", "Patient", "Polite", "Proud", "Quiet", "Rapid",
  "Royal", "Serene", "Silent", "Sincere", "Skilled", "Steady", "Sunny",
  "Swift", "Tidy", "Wise",
] as const;

const ANIMALS = [
  "Alpaca", "Badger", "Beaver", "Bison", "Capybara", "Caribou", "Chamois",
  "Cheetah", "Condor", "Coyote", "Crane", "Dolphin", "Eagle", "Falcon",
  "Ferret", "Finch", "Gazelle", "Gecko", "Gibbon", "Heron", "Ibex", "Iguana",
  "Jaguar", "Jackdaw", "Kestrel", "Koala", "Lemur", "Lynx", "Manatee",
  "Marmot", "Meerkat", "Narwhal", "Ocelot", "Octopus", "Osprey", "Otter",
  "Panther", "Pelican", "Puffin", "Quokka", "Raven", "Seal", "Stork", "Tapir",
  "Toucan", "Vicuna", "Walrus", "Wombat",
] as const;

/** Deterministic label for one student in one evaluation. */
export function pseudonym(evaluationId: string, userId: string): string {
  const next = rng(hashSeed(evaluationId, userId));
  const adjective = ADJECTIVES[Math.floor(next() * ADJECTIVES.length)]!;
  const animal = ANIMALS[Math.floor(next() * ANIMALS.length)]!;
  return `${adjective} ${animal}`;
}

/**
 * Labels a whole cohort, resolving the rare collision by a numeric suffix.
 * The result depends only on `(evaluationId, userIds)`, so every screen that
 * passes the same roster gets the same labels.
 */
export function uniquePseudonyms(
  evaluationId: string,
  userIds: readonly string[],
): Map<string, string> {
  const used = new Map<string, number>();
  const out = new Map<string, string>();
  for (const userId of [...userIds].sort()) {
    const base = pseudonym(evaluationId, userId);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    out.set(userId, seen === 0 ? base : `${base} ${seen + 1}`);
  }
  return out;
}
