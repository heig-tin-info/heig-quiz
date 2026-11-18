/**
 * Finding a student already on the platform, to add them to a roster
 * (ADR-133): the pure part of the rule — how a typed search is cut into
 * words, how a word matches, what a school's tenant is.
 *
 * "Fuzzy" means case-, accent- and word-order-insensitive: every typed word
 * must appear somewhere in the person's name or school address. No typo
 * tolerance, and no Postgres extension: the database only prefilters, with
 * the same folding as {@link foldForSearch} through `translate()`
 * ({@link FOLD_FROM}, {@link FOLD_TO}), and this module decides.
 */

/** Fewer typed characters than this search nothing: a search, not a browse. */
export const STUDENT_SEARCH_MIN_LENGTH = 3;

/** At most this many people are offered. */
export const STUDENT_SEARCH_LIMIT = 10;

/**
 * Lowercase, without accents: how a typed word and a name are compared, here
 * and when names are masked (`maskNames`).
 */
export function foldForSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * The folded words of a search, or none when they hold fewer than
 * {@link STUDENT_SEARCH_MIN_LENGTH} characters in all, blanks and accents
 * aside: "a b" or a letter and its marks search nothing.
 */
export function searchWords(query: string): string[] {
  const words = foldForSearch(query).split(/\s+/).filter((w) => w !== "");
  return words.join("").length < STUDENT_SEARCH_MIN_LENGTH ? [] : words;
}

/** Whether every word appears in one of `fields` (none matches no words). */
export function matchesEveryWord(words: readonly string[], fields: readonly string[]): boolean {
  if (words.length === 0) return false;
  const haystack = fields.map(foldForSearch).join(" ");
  return words.every((word) => haystack.includes(word));
}

/** The domain of an address, lowercased: what follows its last `@`; null without one. */
export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 1 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}

/**
 * A school's tenant (ADR-133 §1): the domains of the institutional addresses
 * a person's last login asserts, once each.
 */
export function tenantOf(institutional: readonly string[]): string[] {
  return [...new Set(institutional.map(addressDomain).filter((d): d is string => d !== null))];
}

/**
 * The addresses of `institutional` inside `tenant`, matched exactly on the
 * domain: `heig-vd.ch` never admits `mail.heig-vd.ch`, as login admission
 * (ADR-111 §2).
 */
export function addressesInTenant(institutional: readonly string[], tenant: readonly string[]): string[] {
  return institutional.filter((address) => {
    const domain = addressDomain(address);
    return domain !== null && tenant.includes(domain);
  });
}

/**
 * The SQL encoding of {@link foldForSearch}, for `translate(lower(x), FROM,
 * TO)`: each Latin letter of U+00C0–U+024F whose fold is one other
 * character maps to it, and the combining marks (U+0300–U+036F), listed
 * last without a counterpart, are deleted. `lower()` folds ASCII only under
 * the C collation, so the upper-case letters are listed too.
 */
function foldTable(): { from: string; to: string } {
  let from = "";
  let to = "";
  for (let cp = 0xc0; cp <= 0x24f; cp += 1) {
    const ch = String.fromCodePoint(cp);
    const folded = foldForSearch(ch);
    if (folded !== ch && [...folded].length === 1) {
      from += ch;
      to += folded;
    }
  }
  for (let cp = 0x300; cp <= 0x36f; cp += 1) from += String.fromCodePoint(cp);
  return { from, to };
}

const FOLD = foldTable();
export const FOLD_FROM = FOLD.from;
export const FOLD_TO = FOLD.to;
