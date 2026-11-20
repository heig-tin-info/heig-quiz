import { useEffect, useId, useState } from "react";

import { contestationDaysOf, FeedbackPolicy } from "@quiz/contracts";
import { CONTESTATION_DAYS_MAX } from "@quiz/domain";

import { useT } from "../i18n";
import { FieldError, fieldErrorProps, SettingRow, TextInput } from "../ui";

/**
 * ADR-139: how many days after the release a student may contest the
 * grading of a question of this EXAM, 0 for none (7 when never chosen).
 * Beside the feedback policy it belongs to; never on an exercise nor a poll,
 * nor under `when: none`, where nothing is shown to contest. The release
 * stores the window's closing instant, which an unrelease leaves: the row
 * is locked once one is stored (`windowSet`), and the results page closes
 * or extends the window from then on.
 *
 * Typed, then committed on blur or Enter, checked by the contract's own
 * field (invariant 7): a value out of range is said under it, never saved.
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
  const id = useId();
  const days = contestationDaysOf(policy);
  const [text, setText] = useState(String(days));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(String(days)), [days]);
  const commit = () => {
    const parsed = FeedbackPolicy.shape.contestationDays.safeParse(text.trim() === "" ? Number.NaN : Number(text));
    setInvalid(!parsed.success || parsed.data === undefined);
    if (parsed.success && parsed.data !== undefined && parsed.data !== days) onChange(parsed.data);
  };
  const error = invalid ? t("eval.contestation.invalid", { max: CONTESTATION_DAYS_MAX }) : null;
  return (
    <SettingRow title={t("eval.contestation")} desc={windowSet ? t("eval.contestation.set") : t("eval.contestation.desc")}>
      <span className="flex flex-col items-end gap-1">
        <span className="flex items-center gap-2 text-[13px] text-fg-muted">
          {/* The row's title is the label: a Field would repeat it. */}
          <TextInput
            id={id}
            aria-label={t("eval.contestation")}
            type="number"
            min={0}
            max={CONTESTATION_DAYS_MAX}
            size="sm"
            className="w-20 text-right tabular-nums"
            disabled={disabled || windowSet}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setInvalid(false);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
            }}
            {...fieldErrorProps(id, error)}
          />
          {t("eval.contestation.unit")}
        </span>
        <FieldError id={id}>{error}</FieldError>
      </span>
    </SettingRow>
  );
}
