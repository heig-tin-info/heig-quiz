import {
  Atom,
  Banknote,
  Binary,
  BookOpen,
  Briefcase,
  Calculator,
  ChartColumn,
  CircuitBoard,
  Code,
  Cog,
  Coins,
  Cpu,
  Database,
  Dna,
  FlaskConical,
  Globe,
  Hammer,
  Landmark,
  Languages,
  Leaf,
  Library,
  Microscope,
  Music,
  Network,
  Palette,
  Pi,
  Scale,
  Sigma,
  Stethoscope,
  Terminal,
  Waves,
  Wrench,
  Zap,
} from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import { lazy, Suspense } from "react";

import type { IconType } from "../ui";
import { DEFAULT_POOL_ICON } from "./poolIcons";

/**
 * The icon of a pool, drawn from its stored lucide name.
 *
 * TWO paths, and the split is measured. The CURATED shelf is a static map:
 * those are the icons on the cards, on every row of the table and on every
 * tile of the picker's first step, and they must be on screen in the first
 * frame. lucide's `DynamicIcon` cannot do that — it renders nothing until an
 * `import()` resolves, and reaching for it pulls `dynamicIconImports`, a map
 * of 1500 lazy imports that measured 250 kB (62 kB gzipped) INSIDE the pools
 * page chunk and turned `dist/` into 1800 files. A shelf of thirty-odd icons
 * costs about 3 kB as real imports, tree-shaken like every other icon in the
 * app.
 *
 * The other path is for a pool wearing one of the ~1500 OTHER names, which
 * the picker's "More icons…" step can set. There `DynamicIcon` is exactly
 * right, and it is loaded lazily, so the catalogue is paid for only by the
 * pools that actually use it — and only once. Until it arrives the default
 * icon holds the place, so the layout never moves.
 *
 * Decorative by default: on a card, in a row and on a picker tile the name is
 * written beside it or carried by the button's `aria-label`, so the glyph
 * itself must stay out of the accessible name.
 */

/**
 * The curated names as components. Keyed by the very strings of
 * `POOL_ICONS`, and `poolIcons.test.ts` asserts the two lists are the same
 * set — the map is a rendering detail, the names stay the source of truth.
 */
export const POOL_ICON_COMPONENTS: Record<string, IconType> = {
  library: Library,
  cpu: Cpu,
  "circuit-board": CircuitBoard,
  zap: Zap,
  waves: Waves,
  "flask-conical": FlaskConical,
  atom: Atom,
  dna: Dna,
  microscope: Microscope,
  leaf: Leaf,
  stethoscope: Stethoscope,
  sigma: Sigma,
  pi: Pi,
  calculator: Calculator,
  "chart-column": ChartColumn,
  code: Code,
  terminal: Terminal,
  database: Database,
  binary: Binary,
  network: Network,
  coins: Coins,
  banknote: Banknote,
  briefcase: Briefcase,
  languages: Languages,
  "book-open": BookOpen,
  wrench: Wrench,
  cog: Cog,
  hammer: Hammer,
  scale: Scale,
  landmark: Landmark,
  palette: Palette,
  music: Music,
  globe: Globe,
};

/** The rest of lucide, on demand. */
const DynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((m) => ({ default: m.DynamicIcon })),
);

export function PoolIcon({
  icon,
  className = "size-5",
}: {
  /** The pool's stored icon name; null (or unknown to this lucide) is the default. */
  icon: string | null | undefined;
  className?: string;
}) {
  const name = icon ?? DEFAULT_POOL_ICON;
  const Curated = POOL_ICON_COMPONENTS[name];
  if (Curated) return <Curated className={className} aria-hidden="true" />;
  const Fallback = POOL_ICON_COMPONENTS[DEFAULT_POOL_ICON]!;
  return (
    <Suspense fallback={<Fallback className={className} aria-hidden="true" />}>
      <DynamicIcon
        name={name as IconName}
        className={className}
        aria-hidden="true"
        // A name this lucide no longer ships (a rename between two releases)
        // draws the default rather than nothing at all.
        fallback={() => <Fallback className={className} aria-hidden="true" />}
      />
    </Suspense>
  );
}
