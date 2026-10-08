import {
  Atom,
  Banknote,
  Binary,
  BookOpen,
  Bot,
  Braces,
  BrainCircuit,
  Briefcase,
  Bug,
  Building2,
  Cable,
  Calculator,
  ChartColumn,
  ChartNetwork,
  ChartPie,
  CircuitBoard,
  Cloud,
  Code,
  Cog,
  Coins,
  Compass,
  Construction,
  Cpu,
  Database,
  Dna,
  DraftingCompass,
  Earth,
  Factory,
  Feather,
  FlaskConical,
  Gavel,
  GitBranch,
  Globe,
  Hammer,
  Handshake,
  HeartPulse,
  Infinity,
  LandPlot,
  Landmark,
  Languages,
  Layers,
  Leaf,
  Library,
  Lightbulb,
  Magnet,
  Map,
  MapPinned,
  Microchip,
  Microscope,
  Music,
  Network,
  Orbit,
  Palette,
  PenTool,
  Pi,
  PiggyBank,
  Quote,
  Radical,
  Radio,
  Receipt,
  Ruler,
  Satellite,
  Scale,
  ScrollText,
  Server,
  Shapes,
  Shield,
  Sigma,
  SpellCheck,
  Sprout,
  SquareFunction,
  Stethoscope,
  Table,
  Telescope,
  Terminal,
  Thermometer,
  TrendingUp,
  Users,
  Waves,
  Weight,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { IconName } from "lucide-react/dynamic";
import { lazy, Suspense } from "react";

import type { PoolColor } from "@quiz/contracts";

import { CUSTOM_ICON_COMPONENTS } from "./customIcons";
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
 * page chunk and turned `dist/` into 1800 files. A shelf of about 120 icons
 * costs about 15 kB gzipped as real imports (measured), tree-shaken like
 * every other icon in the app.
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
export const POOL_ICON_COMPONENTS: Record<string, LucideIcon> = {
  library: Library,
  code: Code,
  terminal: Terminal,
  binary: Binary,
  braces: Braces,
  bug: Bug,
  "git-branch": GitBranch,
  server: Server,
  cloud: Cloud,
  network: Network,
  shield: Shield,
  bot: Bot,
  "brain-circuit": BrainCircuit,
  database: Database,
  table: Table,
  "chart-network": ChartNetwork,
  cpu: Cpu,
  "circuit-board": CircuitBoard,
  microchip: Microchip,
  zap: Zap,
  cable: Cable,
  radio: Radio,
  atom: Atom,
  orbit: Orbit,
  magnet: Magnet,
  waves: Waves,
  thermometer: Thermometer,
  telescope: Telescope,
  lightbulb: Lightbulb,
  sigma: Sigma,
  pi: Pi,
  radical: Radical,
  infinity: Infinity,
  "square-function": SquareFunction,
  calculator: Calculator,
  "chart-column": ChartColumn,
  shapes: Shapes,
  wrench: Wrench,
  cog: Cog,
  hammer: Hammer,
  ruler: Ruler,
  "drafting-compass": DraftingCompass,
  weight: Weight,
  construction: Construction,
  factory: Factory,
  "flask-conical": FlaskConical,
  dna: Dna,
  microscope: Microscope,
  leaf: Leaf,
  sprout: Sprout,
  stethoscope: Stethoscope,
  "heart-pulse": HeartPulse,
  coins: Coins,
  banknote: Banknote,
  briefcase: Briefcase,
  "chart-pie": ChartPie,
  "trending-up": TrendingUp,
  handshake: Handshake,
  "piggy-bank": PiggyBank,
  receipt: Receipt,
  "building-2": Building2,
  users: Users,
  languages: Languages,
  "book-open": BookOpen,
  feather: Feather,
  "pen-tool": PenTool,
  "scroll-text": ScrollText,
  quote: Quote,
  "spell-check": SpellCheck,
  globe: Globe,
  earth: Earth,
  map: Map,
  layers: Layers,
  "land-plot": LandPlot,
  compass: Compass,
  "map-pinned": MapPinned,
  satellite: Satellite,
  scale: Scale,
  gavel: Gavel,
  landmark: Landmark,
  palette: Palette,
  music: Music,
  ...CUSTOM_ICON_COMPONENTS,
};

/** The rest of lucide, on demand. */
const DynamicIcon = lazy(() =>
  import("lucide-react/dynamic").then((m) => ({ default: m.DynamicIcon })),
);

export function PoolIcon({
  icon,
  color,
  className = "size-5",
}: {
  /** The pool's stored icon name; null (or unknown to this lucide) is the default. */
  icon: string | null | undefined;
  /** The pool's colour (#213); null keeps whatever ink the call site gives. */
  color?: PoolColor | null | undefined;
  className?: string;
}) {
  // The colour is a token (`--pool-<name>` in style.css, swapped under
  // html.dark) set inline: it then wins over the call site's own `text-fg-*`,
  // the grey a pool with no colour keeps exactly as before, and the fifteen
  // names need no class map for Tailwind to find.
  const style = color ? { color: `var(--pool-${color})` } : undefined;
  const name = icon ?? DEFAULT_POOL_ICON;
  const Curated = POOL_ICON_COMPONENTS[name];
  if (Curated) return <Curated className={className} style={style} aria-hidden="true" />;
  const Fallback = POOL_ICON_COMPONENTS[DEFAULT_POOL_ICON]!;
  return (
    <Suspense fallback={<Fallback className={className} style={style} aria-hidden="true" />}>
      <DynamicIcon
        name={name as IconName}
        className={className}
        style={style}
        aria-hidden="true"
        // A name this lucide no longer ships (a rename between two releases)
        // draws the default rather than nothing at all.
        fallback={() => <Fallback className={className} style={style} aria-hidden="true" />}
      />
    </Suspense>
  );
}
