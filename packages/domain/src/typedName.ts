/**
 * Whether a name typed to confirm a deletion matches the name it confirms
 * (a classroom, a project, a Quiz-mode journal).
 *
 * The person copies or types what the dialog shows, and a browser shows a
 * name with its whitespace collapsed: a name stored with two spaces, a
 * non-breaking space or a typographic dash (common in names imported from
 * heig-classroom) could never be matched (#886). Both sides are therefore
 * compared in Unicode NFKC, with every run of whitespace made one space,
 * every dash made `-`, and the ends trimmed. Case still counts: the typed
 * name is a deliberate act, not a search.
 */
export function confirmsName(typed: string, name: string): boolean {
  return comparable(typed) === comparable(name);
}

function comparable(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‐-―−﹘﹣－]/g, "-")
    .replace(/\s+/gu, " ")
    .trim();
}
