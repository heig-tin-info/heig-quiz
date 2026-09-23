/**
 * The few shared class strings and helpers of this package's components.
 *
 * A `qt-*` package cannot import `apps/web/src/ui.tsx` (packages never depend
 * on an app), and `packages/ui` is a later work package, so the markup here is
 * plain semantic HTML carrying the design tokens of `apps/web/DESIGN.md`:
 * hairlines and surfaces, no shadow in the page flow, no raw colour, no `dark:`
 * variant — the tokens swap by themselves.
 */

/** Field chrome: 12 px radius, `line-strong` hairline, accent ring on focus. */
export const inputClass =
  "rounded-xl border border-line-strong bg-surface px-3 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-faint hover:border-fg-faint focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-50";

export const labelClass = "text-[13px] font-medium text-fg";
export const helpClass = "text-xs text-fg-faint";
export const sectionClass = "flex flex-col gap-2";

/** Secondary button chrome (pill, hairline), for the editor's add/remove actions. */
export const buttonClass =
  "inline-flex h-7 shrink-0 select-none items-center justify-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-[13px] font-medium text-fg transition-colors hover:bg-surface-2 disabled:opacity-50";
