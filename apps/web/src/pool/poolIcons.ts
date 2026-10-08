// `import type` on purpose, and the ONLY reference to lucide's dynamic entry
// point in this module: the type is erased at build time, while a runtime
// import of it would pull the 1500-entry `dynamicIconImports` map (about
// 250 kB, 62 kB gzipped) into the pools page — see `PoolIcon.tsx`.
import type { IconName } from "lucide-react/dynamic";

import type { CustomIconName } from "./customIcons";

/**
 * The icon of a pool (F-POOL-05): an icon NAME, stored as a string on the
 * pool and drawn by `PoolIcon` beside it — a lucide name, or one of the
 * few drawn for Quiz (`customIcons.ts`).
 *
 * One module holds the names, and nothing else does: the picker, the card,
 * the table and the mock all read them from here, so a school subject gains
 * an icon in one place. They are typed against lucide's own catalogue
 * (`IconName`) and the custom set, which turns a typo into a compile error,
 * and `poolIcons.test` asserts the list against both AND against the static
 * map that draws it — a name lucide renames between two releases must not
 * become a blank square on a teacher's shelf.
 *
 * The CURATED shelf is what the picker offers first, one group per domain
 * HEIG-VD teaches, so a teacher scans a heading rather than a hundred
 * tiles. Everything else in lucide is one "More icons…" step away.
 */
export type PoolIconName = IconName | CustomIconName;

export const DEFAULT_POOL_ICON: IconName = "library";

export const POOL_ICON_GROUPS = [
  {
    id: "languages",
    icons: [
      "python",
      "c",
      "cpp",
      "csharp",
      "java",
      "javascript",
      "typescript",
      "rust",
      "golang",
      "kotlin",
      "php",
      "perl",
      "bash",
      "powershell",
      "nodejs",
      "html5",
      "css3",
    ],
  },
  {
    id: "computing",
    icons: [
      "code",
      "terminal",
      "binary",
      "braces",
      "bug",
      "git-branch",
      "git",
      "github",
      "gitlab",
      "docker",
      "chrome",
      "vscode",
      "windows",
      "android",
      "server",
      "cloud",
      "network",
      "shield",
      "bot",
      "brain-circuit",
    ],
  },
  {
    id: "data",
    icons: ["database", "table", "sql", "mysql", "mongodb", "chart-network"],
  },
  {
    id: "electronics",
    icons: [
      "cpu",
      "circuit-board",
      "microchip",
      "resistor",
      "logic-gate",
      "zap",
      "cable",
      "radio",
      "plc",
      "arduino",
    ],
  },
  {
    id: "physics",
    icons: ["atom", "orbit", "magnet", "waves", "spring", "thermometer", "telescope", "lightbulb"],
  },
  {
    id: "maths",
    icons: [
      "sigma",
      "pi",
      "radical",
      "infinity",
      "integral",
      "matrix",
      "square-function",
      "calculator",
      "chart-column",
      "shapes",
    ],
  },
  {
    id: "engineering",
    icons: [
      "wrench",
      "cog",
      "hammer",
      "beam",
      "truss",
      "ruler",
      "drafting-compass",
      "weight",
      "crane",
      "construction",
      "factory",
    ],
  },
  {
    id: "science",
    icons: ["flask-conical", "dna", "microscope", "leaf", "sprout", "stethoscope", "heart-pulse"],
  },
  {
    id: "management",
    icons: [
      "coins",
      "banknote",
      "briefcase",
      "chart-pie",
      "trending-up",
      "handshake",
      "piggy-bank",
      "receipt",
      "building-2",
      "users",
    ],
  },
  {
    id: "letters",
    icons: ["languages", "book-open", "feather", "pen-tool", "scroll-text", "quote", "spell-check"],
  },
  {
    id: "geomatics",
    icons: [
      "globe",
      "earth",
      "map",
      "layers",
      "land-plot",
      "contour",
      "compass",
      "map-pinned",
      "satellite",
      "latitude",
    ],
  },
  { id: "society", icons: ["scale", "gavel", "landmark", "palette", "music"] },
] as const satisfies readonly { id: string; icons: readonly PoolIconName[] }[];

export type PoolIconGroup = (typeof POOL_ICON_GROUPS)[number]["id"];

export const POOL_ICONS: readonly PoolIconName[] = POOL_ICON_GROUPS.flatMap((g) => g.icons);

/** How many results the "More icons…" step draws at once (~1500 names exist). */
export const ICON_SEARCH_LIMIT = 120;
