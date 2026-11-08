type GradedCase = { name: string; visible: boolean; points: number; ok: boolean };

/**
 * The one rule of a hidden case in a student's details (decision D15, ADR-096,
 * #998), shared by `code`, `blocks` and `circuit`, under every policy, a shown
 * key included: a visible case travels as it is; a hidden one keeps its verdict
 * and its points, its name only when the policy opens the names (`#n`
 * otherwise), and the coarse fields its type picks with `coarse` — never what
 * the case was fed nor what the answer did on it.
 */
export function maskHiddenCases<C extends GradedCase, R extends object>(
  cases: readonly C[],
  showNames: boolean,
  coarse: (hidden: C) => R,
) {
  return cases.map((c, i) =>
    c.visible
      ? c
      : { name: showNames ? c.name : `#${i + 1}`, visible: false as const, points: c.points, ok: c.ok, ...coarse(c) },
  );
}
