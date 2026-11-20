import { useEffect, useId, useState } from "react";

import { ContestationDays } from "@quiz/contracts";
import { CONTESTATION_DAYS_MAX } from "@quiz/domain";

import { useT } from "../i18n";
import { FieldError, fieldErrorProps, SettingRow, TextInput } from "../ui";

/**
 * ADR-139: how many days after the release a student may contest a unit
 * of this work, 0 for none — an exam's (its feedback policy's) or a
 * project's graded by criteria. The caller disables it once the release
 * stored the window's closing instant (`disabled`), the results then
 * closing or extending the window.
 * Typed, then committed on blur or Enter, checked by the contract's own
 * field (invariant 7): a value out of range is said under it, never saved.
 */
export function ContestationDaysRow({
  days,
  desc,
  onChange,
  disabled,
}: {
  days: number;
  /** The row's sub-text: what the days count from, or that the release set the window. */
  desc: string;
  onChange: (contestationDays: number) => void;
  disabled: boolean;
}) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState(String(days));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(String(days)), [days]);
  const commit = () => {
    const parsed = ContestationDays.safeParse(text.trim() === "" ? Number.NaN : Number(text));
    setInvalid(!parsed.success);
    if (parsed.success && parsed.data !== days) onChange(parsed.data);
  };
  const error = invalid ? t("eval.contestation.invalid", { max: CONTESTATION_DAYS_MAX }) : null;
  return (
    <SettingRow title={t("eval.contestation")} desc={desc}>
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
            disabled={disabled}
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
