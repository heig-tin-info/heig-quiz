import { useMemo } from "react";

import { useT } from "../i18n";
import type { FormulaLabels } from "./formula";

/** Why a formula was not drawn, in the reader's language (`formula.ts`). Stable per locale. */
export function useFormulaLabels(): FormulaLabels {
  const t = useT();
  const macro = t("md.formula.refusedMacro");
  const tooDeep = t("md.formula.refusedDepth");
  return useMemo(() => ({ macro, tooDeep }), [macro, tooDeep]);
}
