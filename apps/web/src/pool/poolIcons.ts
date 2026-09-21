// `import type` on purpose, and the ONLY reference to lucide's dynamic entry
// point in this module: the type is erased at build time, while a runtime
// import of it would pull the 1500-entry `dynamicIconImports` map (about
// 250 kB, 62 kB gzipped) into the pools page — see `PoolIcon.tsx`.
import type { IconName } from "lucide-react/dynamic";

/**
 * The icon of a pool (F-POOL-05): a lucide icon NAME, stored as a string on
 * the pool and drawn by `PoolIcon` beside it.
 *
 * One module holds the names, and nothing else does: the picker, the card,
 * the table and the mock all read them from here, so a school subject gains
 * an icon in one place. They are typed against lucide's own catalogue
 * (`IconName`), which turns a typo into a compile error, and `poolIcons.test`
 * asserts the list against the catalogue AND against the static map that
 * draws it — a name lucide renames between two releases must not become a
 * blank square on a teacher's shelf.
 *
 * The CURATED set is what the picker offers first: the domains HEIG-VD
 * teaches, one or two icons each — electronics, physics, chemistry, maths,
 * computing, economics, languages, mechanics, life sciences, law, arts,
 * geography. Everything else in lucide is one "More icons…" step away, so
 * this list stays a shelf of good defaults instead of a catalogue nobody
 * reads.
 */
export const DEFAULT_POOL_ICON: IconName = "library";

export const POOL_ICONS: readonly IconName[] = [
  // Electronics, signals, physics
  "cpu",
  "circuit-board",
  "zap",
  "waves",
  // Chemistry and life sciences
  "flask-conical",
  "atom",
  "dna",
  "microscope",
  "leaf",
  "stethoscope",
  // Mathematics
  "sigma",
  "pi",
  "calculator",
  "chart-column",
  // Computing
  "code",
  "terminal",
  "database",
  "binary",
  "network",
  // Economics and management
  "coins",
  "banknote",
  "briefcase",
  // Languages and letters
  "languages",
  "book-open",
  // Mechanics and workshop
  "wrench",
  "cog",
  "hammer",
  // Law, arts, geography
  "scale",
  "landmark",
  "palette",
  "music",
  "globe",
];

/** How many results the "More icons…" step draws at once (~1500 names exist). */
export const ICON_SEARCH_LIMIT = 120;
