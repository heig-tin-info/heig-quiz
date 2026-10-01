import { Dices } from "lucide-react";

import { useT } from "../i18n";
import { Badge } from "../ui";

/**
 * "Parameterized" (ADR-056 §8): the question's published version draws its
 * values per attempt. One pill for the pool's table, its cards and the
 * editor's header; the word is not "Generated", which names the LLM actions.
 */
export function ParameterizedBadge() {
  const t = useT();
  return (
    <Badge tone="zinc" icon={Dices}>
      {t("pool.parameterized")}
    </Badge>
  );
}
