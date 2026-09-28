import type { PoolColor } from "@quiz/contracts";

/**
 * The colour of a pool's icon (#213) as Tailwind classes, one pair per
 * `PoolColor` name: the ink of the icon and the fill of its swatch.
 *
 * Written out whole because Tailwind only generates a class it finds as a
 * literal string. The values behind them are tokens (`--pool-<name>` in
 * `style.css`, swapped under `html.dark`), so no theme reaches this map.
 *
 * The ink carries the important suffix: `cx` joins classes without merging
 * them, and the icon's call site already sets a `text-fg-*` of its own — the
 * grey a pool with no colour keeps, exactly as before.
 */
export const POOL_COLOR_CLASS: Record<PoolColor, { ink: string; fill: string }> = {
  red: { ink: "text-pool-red!", fill: "bg-pool-red" },
  orange: { ink: "text-pool-orange!", fill: "bg-pool-orange" },
  amber: { ink: "text-pool-amber!", fill: "bg-pool-amber" },
  yellow: { ink: "text-pool-yellow!", fill: "bg-pool-yellow" },
  lime: { ink: "text-pool-lime!", fill: "bg-pool-lime" },
  green: { ink: "text-pool-green!", fill: "bg-pool-green" },
  emerald: { ink: "text-pool-emerald!", fill: "bg-pool-emerald" },
  teal: { ink: "text-pool-teal!", fill: "bg-pool-teal" },
  cyan: { ink: "text-pool-cyan!", fill: "bg-pool-cyan" },
  sky: { ink: "text-pool-sky!", fill: "bg-pool-sky" },
  blue: { ink: "text-pool-blue!", fill: "bg-pool-blue" },
  indigo: { ink: "text-pool-indigo!", fill: "bg-pool-indigo" },
  violet: { ink: "text-pool-violet!", fill: "bg-pool-violet" },
  purple: { ink: "text-pool-purple!", fill: "bg-pool-purple" },
  pink: { ink: "text-pool-pink!", fill: "bg-pool-pink" },
};
