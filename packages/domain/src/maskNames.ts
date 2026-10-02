/**
 * The masking of student answers before they reach an LLM provider
 * (N-DATA-05, ADR-063 §4): the names and e-mail addresses of the people of
 * an evaluation, wherever a student typed them, become {@link MASK}.
 */

/** What replaces a name; the grading prompt explains it to the model. */
export const MASK = "[student]";

/**
 * Under this many letters a name part ALONE is not masked: "Le" or "Do" are
 * words of every French essay. Beside the rest of its name it is: "Wu Li",
 * or a compound family name such as "Le Gall", goes whole, whatever the
 * length of its parts.
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
/** What may stand between two words of one name: spaces, a hyphen, an apostrophe. */
const NAME_GAP = /^[\s\-'’]+$/u;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordsOf = (text: string): string[] => (text.match(WORD) ?? []).map(fold);

interface Token {
  start: number;
  end: number;
  word: string;
}

/** Whether `name` is spelled by the tokens from `at` on, one name's gaps between them. */
function spells(text: string, tokens: Token[], at: number, name: string[]): boolean {
  if (at + name.length > tokens.length) return false;
  return name.every((word, k) => {
    const token = tokens[at + k]!;
    if (token.word !== word) return false;
    return k === 0 || NAME_GAP.test(text.slice(tokens[at + k - 1]!.end, token.start));
  });
}

/**
 * The text with every person's full name (given then family, or family then
 * given, any length), every part of a name of {@link MIN_PART} letters or
 * more, and every e-mail address replaced by {@link MASK}: whole words only,
 * ignoring case and accents. A name that is also an ordinary word (Pascal,
 * Max) is masked everywhere: a lost word costs less than a leaked name.
 */
export function maskNames(text: string, people: readonly MaskedPerson[]): string {
  const parts = new Set<string>();
  const names: string[][] = [];
  const emails: string[] = [];
  for (const p of people) {
    const given = wordsOf(p.givenName);
    const family = wordsOf(p.familyName);
    for (const word of [...given, ...family]) if (word.length >= MIN_PART) parts.add(word);
    if (given.length > 0 && family.length > 0) names.push([...given, ...family], [...family, ...given]);
    // A compound name alone ("Le Gall", "Jean Marc") is one name too.
    for (const compound of [given, family]) if (compound.length > 1) names.push(compound);
    if (p.email.trim() !== "") emails.push(p.email.trim());
  }
  const unmailed = emails.length > 0 ? text.replace(new RegExp(emails.map(escape).join("|"), "gi"), MASK) : text;

  const tokens = [...unmailed.matchAll(WORD)].map((m) => ({ start: m.index, end: m.index + m[0].length, word: fold(m[0]) }));
  const masked = tokens.map((t) => parts.has(t.word));
  tokens.forEach((_, i) => {
    for (const name of names) if (spells(unmailed, tokens, i, name)) masked.fill(true, i, i + name.length);
  });

  let out = "";
  let from = 0;
  tokens.forEach((t, i) => {
    if (!masked[i]) return;
    out += unmailed.slice(from, t.start) + MASK;
    from = t.end;
  });
  return out + unmailed.slice(from);
}
