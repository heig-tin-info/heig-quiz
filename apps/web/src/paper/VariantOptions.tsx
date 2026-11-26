/**
 * The `<option>`s of a paper's variants, A to the last (ADR-148): what the
 * export sheet downloads and what the paper entry types from.
 */
import { variantLetter } from "@quiz/domain";

import { useT } from "../i18n";

export function VariantOptions({ count }: { count: number }) {
  const t = useT();
  return Array.from({ length: count }, (_, i) => (
    <option key={i} value={i + 1}>
      {t("paper.variantLetter", { letter: variantLetter(i + 1) })}
    </option>
  ));
}
