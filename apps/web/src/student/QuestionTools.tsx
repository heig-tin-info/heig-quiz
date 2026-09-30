import { CircleSlash, Eraser, Flag } from "lucide-react";

import { maySkip } from "@quiz/domain";

import type { PlayerItem } from "../attempt/playerReducer";
import { useT } from "../i18n";
import { cx, IconButton, ToggleChip } from "../ui";

/**
 * The tool of the ANSWER under the question (issue #128): one neutral chip.
 * Exactly one of Clear and Leave-unanswered can apply at a time, because
 * they read the same two facts. Nothing at all when neither applies — and
 * no Leave-unanswered where the question is validated by hand: there the
 * primary button itself reads "Leave blank and continue", and two
 * near-synonyms on one screen would be the confusion this removed. The
 * review flag is the question's, not the answer's: it sits in the card's
 * corner (`FlagButton`).
 */
export function QuestionTools({
  item,
  answered,
  readOnly,
  canValidate,
  onClear,
  onSkip,
}: {
  item: PlayerItem;
  answered: boolean;
  readOnly: boolean;
  canValidate: boolean;
  onClear: () => void;
  onSkip: () => void;
}) {
  const t = useT();
  // "Clear" is multiple choice only: the other types are emptied by hand,
  // and with negative points withdrawing a selection must be possible.
  const clearable = item.type === "mcq" && answered && !readOnly;
  const skippable = !readOnly && !canValidate && maySkip({ answered });
  if (!clearable && !skippable) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {clearable ? (
        <ToggleChip tone="neutral" icon={Eraser} label={t("player.clear")} onToggle={onClear} />
      ) : skippable ? (
        <ToggleChip
          tone="neutral"
          icon={CircleSlash}
          // One label, on or off: the badge above already says "Left
          // unanswered", and the pressed chip is how it is taken back.
          label={t("player.skip")}
          pressed={item.skipped}
          onToggle={onSkip}
        />
      ) : null}
    </div>
  );
}

/**
 * The review flag of the current question, an icon in the corner of its
 * card: a note to self, so it stays out of the way of the answer. A closed
 * question keeps a flag that is ON (it still means something in the list),
 * disabled; an unflagged one has nothing to say.
 */
export function FlagButton({
  item,
  readOnly,
  onFlag,
}: {
  item: PlayerItem;
  readOnly: boolean;
  onFlag: () => void;
}) {
  const t = useT();
  if (readOnly && !item.flagged) return null;
  return (
    <IconButton
      // One label, on or off: `aria-pressed` carries the state, and a
      // label that changed with it would be read twice.
      label={t("player.flag")}
      aria-pressed={item.flagged}
      disabled={readOnly}
      onClick={onFlag}
      // Filled in `fg` when on, not in the accent: the accent is the
      // screen's one action, and `warning` falls under 3:1 in the dark theme.
      className={cx(item.flagged && "!text-fg [&_svg]:fill-current")}
    >
      <Flag />
    </IconButton>
  );
}
