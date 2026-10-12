import { Ban, Candy } from "lucide-react";

import type { ItemCounting } from "@quiz/contracts";

import type { Dict } from "./i18n";
import { useT } from "./i18n";
import { Badge, Tip } from "./ui";

/**
 * The mark of a bonus item (ADR-052), wherever one is drawn: "Bonus question"
 * in the player and on the feedback page, "bonus" beside the name in the
 * builder. The tooltip says what it means for the total.
 */
export function BonusLabel({
  label = "player.bonus",
  hint = "player.bonus.hint",
}: {
  label?: keyof Dict;
  hint?: keyof Dict;
}) {
  const t = useT();
  return (
    <Tip label={t(hint)}>
      <Badge tone="zinc" icon={Candy}>
        {t(label)}
      </Badge>
    </Tip>
  );
}

/**
 * The mark of how an item counts, where a student or a teacher reads a
 * question: "Bonus question" (ADR-052), "Not counted" for an item the
 * teacher neutralized after the evaluation (ADR-108), nothing for a normal
 * one.
 */
export function CountingLabel({ counting }: { counting: ItemCounting }) {
  const t = useT();
  if (counting === "bonus") return <BonusLabel />;
  if (counting === "normal") return null;
  return (
    <Tip label={t("counting.neutralized.hint")}>
      <Badge tone="zinc" icon={Ban}>
        {t("counting.neutralized")}
      </Badge>
    </Tip>
  );
}
