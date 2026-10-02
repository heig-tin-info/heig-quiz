/**
 * The masking of student answers before they reach an LLM provider
 * (N-DATA-05, ADR-063 §4): the names and e-mail addresses of the people of
 * an evaluation, wherever a student typed them, become {@link MASK}.
 */

/** What replaces a name; the grading prompt explains it to the model. */
export const MASK = "[student]";

/**
 * Under this many letters a name part is not masked: "Le" or "Do" are words
 * of every French essay, and masking them would cost more than the part can
 * leak, beside the rest of the name.
 */
const MIN_PART = 3;

export interface MaskedPerson {
  givenName: string;
  familyName: string;
  email: string;
}

/** Lowercase, without accents: how a name and a word are compared. */
const fold = (word: string): string =>
  word
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

/** A word: letters, with their combining marks. A hyphen or an apostrophe separates two. */
const WORD = /\p{L}[\p{L}\p{M}]*/gu;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text with every word that is a part of a person's name, and every one
 * of their e-mail addresses, replaced by {@link MASK}: whole words only,
 * ignoring case and accents. A name that is also an ordinary word (Pascal,
 * Max) is masked everywhere: a lost word costs less than a leaked name.
 */
export function maskNames(text: string, people: readonly MaskedPerson[]): string {
  const parts = new Set<string>();
  const emails: string[] = [];
  for (const p of people) {
    for (const word of `${p.givenName} ${p.familyName}`.match(WORD) ?? []) {
      if (word.length >= MIN_PART) parts.add(fold(word));
    }
    if (p.email.trim() !== "") emails.push(p.email.trim());
  }
  let out = text;
  if (emails.length > 0) out = out.replace(new RegExp(emails.map(escape).join("|"), "gi"), MASK);
  if (parts.size === 0) return out;
  return out.replace(WORD, (word) => (parts.has(fold(word)) ? MASK : word));
}
