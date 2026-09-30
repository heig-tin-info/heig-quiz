import { CircleSlash, Eraser, Flag } from "lucide-react";

import { maySkip } from "@quiz/domain";

import type { PlayerItem } from "../attempt/playerReducer";
import { useT } from "../i18n";
import { cx, ToggleChip } from "../ui";

/**
 * The question's tools (issue #128): ONE toolbar of neutral chips under the
 * question — the review flag, and the one tool of the answer. Exactly one of
 * Clear and I-won't-answer can apply at a time, because they read the same
 * two facts. Nothing at all when none applies.
 *
 * On a wide screen the flag leaves for the side column (`PlayerRail`), next
 * to the question list it marks, and `withFlag` is off: the two tools of the
 * ANSWER stay under the answer.
 */
export function QuestionTools({
  item,
  answered,
  readOnly,
  withFlag = true,
  onFlag,
  onClear,
  onSkip,
}: {
  item: PlayerItem;
  answered: boolean;
  readOnly: boolean;
  withFlag?: boolean;
  onFlag: () => void;
  onClear: () => void;
  onSkip: () => void;
}) {
  const t = useT();
  // "Clear" is multiple choice only: the other types are emptied by hand,
  // and with negative points withdrawing a selection must be possible.
  const clearable = item.type === "mcq" && answered && !readOnly;
  const skippable = !readOnly && maySkip({ answered });
  const flaggable = withFlag && isFlaggable(item, readOnly);
  if (!flaggable && !clearable && !skippable) return null;
  return (
    <div role="group" aria-label={t("player.tools")} className="mt-3 flex flex-wrap items-center gap-2">
      {flaggable ? <FlagChip item={item} readOnly={readOnly} onFlag={onFlag} /> : null}
      {clearable ? (
        <ToggleChip tone="neutral" icon={Eraser} label={t("player.clear")} onToggle={onClear} />
      ) : skippable ? (
        <ToggleChip
          tone="neutral"
          icon={CircleSlash}
          // One label, on or off: the badge above already says "Won't
          // answer", and the pressed chip is how it is taken back.
          label={t("player.skip")}
          pressed={item.skipped}
          onToggle={onSkip}
        />
      ) : null}
    </div>
  );
}

/**
 * A closed question keeps a flag that is ON (it still means something in the
 * list), disabled; an unflagged one has nothing to say.
 */
export function isFlaggable(item: PlayerItem, readOnly: boolean): boolean {
  return !readOnly || item.flagged;
}

/** The review flag of the current question, under it or in the side column. */
export function FlagChip({
  item,
  readOnly,
  onFlag,
}: {
  item: PlayerItem;
  readOnly: boolean;
  onFlag: () => void;
}) {
  const t = useT();
  return (
    <ToggleChip
      tone="neutral"
      icon={Flag}
      // One label, on or off: `aria-pressed` carries the state, and a
      // label that changed with it would be read twice.
      label={t("player.flag")}
      pressed={item.flagged}
      disabled={readOnly}
      onToggle={onFlag}
      // Filled when on, in the chip's own text colour: `warning` on the
      // pressed fill falls under 3:1 in the dark theme.
      className={cx(item.flagged && "[&_svg]:fill-current")}
    />
  );
}
