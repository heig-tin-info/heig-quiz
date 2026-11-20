import { contestationDaysOf, type FeedbackPolicy } from "@quiz/contracts";

import { ContestationDaysRow } from "../contestation/ContestationDays";
import { useT } from "../i18n";

/**
 * ADR-139: how many days after the release a student may contest the
 * grading of a question of this EXAM, 0 for none (7 when never chosen).
 * Beside the feedback policy it belongs to; never on an exercise nor a poll,
 * nor under `when: none`, where nothing is shown to contest. The release
 * stores the window's closing instant, which an unrelease leaves: the row
 * is locked once one is stored (`windowSet`), and the results page closes
 * or extends the window from then on. The field is the shared
 * {@link ContestationDaysRow}, a project's too.
 */
export function ContestationSetting({
  policy,
  onChange,
  disabled,
  windowSet,
}: {
  policy: FeedbackPolicy;
  onChange: (contestationDays: number) => void;
  disabled: boolean;
  windowSet: boolean;
}) {
  const t = useT();
  return (
    <ContestationDaysRow
      days={contestationDaysOf(policy)}
      desc={windowSet ? t("eval.contestation.set") : t("eval.contestation.desc")}
      onChange={onChange}
      disabled={disabled || windowSet}
    />
  );
}
