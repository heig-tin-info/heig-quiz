import { en } from "../i18n/en";
import type { FormulaLabels } from "../markdown/formula";

/** The English reasons, for a test that calls a pure renderer without a locale. */
export const FORMULA_LABELS: FormulaLabels = {
  macro: en["md.formula.refusedMacro"],
  tooDeep: en["md.formula.refusedDepth"],
};
