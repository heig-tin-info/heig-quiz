/** The entities `decodeEntities` knows by name; any other stays as typed. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/**
 * What the reader sees for the entities written in a text: numeric ones
 * (`&#233;`, `&#xE9;`, never a surrogate half) and the named ones of
 * {@link NAMED}. For text that is never parsed as HTML again — a journal
 * heading (title, TOC), a formula or a code span of the web's markdown —
 * where an entity left encoded would show as `&amp;` to a student.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}
