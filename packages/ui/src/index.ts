/**
 * `@quiz/ui` — the design-system primitives the question-type surfaces share
 * (docs/spec/05-architecture.md §5.2, docs/PLAN-MVP.md §8).
 *
 * The five `qt-*` packages cannot import `apps/web/src/ui.tsx` (a package
 * never depends on an app), so each of them used to carry its own copy of the
 * same class lists and the same small components — and the copies drifted.
 * They live here once.
 *
 * Rules of the package:
 *
 *  - It imports React, `react-dom` and `@quiz/core` only: never `apps/web`,
 *    never a `qt-*` package (decision D1 keeps the graph acyclic).
 *  - No string of its own. Every word a primitive shows arrives as a prop,
 *    already translated by the caller's `strings` (invariant 1, N-I18N-01).
 *  - Semantic tokens only (`bg-surface`, `text-fg-muted`, `rounded-field`…):
 *    `apps/web/DESIGN.md` owns their values and they swap under `html.dark`
 *    by themselves, so nothing here carries a `dark:` variant (invariant 2).
 *    `apps/web/src/style.css` lists this package in its `@source` so Tailwind
 *    generates the utilities written here.
 */
export {
  badge,
  button,
  buttonClass,
  card,
  cardTitleClass,
  codeArea,
  cx,
  helpClass,
  hint,
  input,
  inputClass,
  inputSm,
  label,
  labelClass,
  lockedBlock,
  sectionClass,
  sectionTitle,
  setting,
  table,
  type BadgeTone,
} from "./styles.js";
export { breakdownOf, isLocked, markdown } from "./content.js";
export { CheckboxField, FieldCell, NumberField, Segmented } from "./fields.js";
export { IssueList } from "./issues.js";
export { AsideSection, TryPanel, type TryStatus } from "./panels.js";
export { patchAt, RemoveRowButton, removeAt, RowHead, RowList, RowListHeader } from "./rows.js";
export { AdvancedDisclosure, EditorSection, PromptSection } from "./sections.js";
export { PromptField } from "./PromptField.js";
export { pointsOrDash, ScoreHeader, Verdict, verdictTone } from "./verdict.js";
