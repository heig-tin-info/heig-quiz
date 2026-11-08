/** What a hidden case keeps under every policy; its type's coarse fields may never redefine it. */
type HiddenBase = { name: string; visible: false; points: number; ok: boolean };
type GradedCase = { name: string; visible: boolean; points: number; ok: boolean };

/**
 * The one rule of a hidden case in a student's details (decision D15, ADR-096,
 * #998), shared by `code`, `blocks` and `circuit`, under every policy, a shown
 * key included: a visible case travels as it is; a hidden one keeps its verdict
 * and its points, its name only when the policy opens the names (`#n`
 * otherwise), and the coarse fields its type picks with `coarse` — never what
 * the case was fed nor what the answer did on it. The fixed fields are written
 * last, so `coarse` can never reopen a name nor turn a case visible.
 */
export function maskHiddenCases<C extends GradedCase, R extends object>(
  cases: readonly C[],
  showNames: boolean,
  coarse: (hidden: C) => R & { [K in keyof HiddenBase]?: never },
): (C | (Omit<R, keyof HiddenBase> & HiddenBase))[] {
  return cases.map((c, i) =>
    c.visible
      ? c
      : { ...coarse(c), name: showNames ? c.name : `#${i + 1}`, visible: false as const, points: c.points, ok: c.ok },
  );
}
