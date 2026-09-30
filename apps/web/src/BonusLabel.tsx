import { Candy } from "lucide-react";

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
