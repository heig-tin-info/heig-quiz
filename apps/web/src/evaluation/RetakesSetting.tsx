import { useEffect, useState } from "react";

import { retakesOf, type EvaluationDetail, type RetakeSettings } from "@quiz/contracts";

import { useT } from "../i18n";
import { Card, cx, inputClass, inputSize, Segmented, SettingRow, Switch } from "../ui";
import type { useEvaluationPatch } from "./usePatch";

/**
 * F-EVAL-15 (ADR-025): several attempts on an exercise.
 *
 * Shown for an exercise only — the server refuses the setting on an exam —
 * and frozen like the rest of the structure once somebody has started. One
 * switch; the two details it brings (which attempt counts, how many) appear
 * only once it is on, so a teacher who never wants retakes reads one line.
 *
 * The rule travels whole (`EvaluationSettingsPatch.retakes`): every change
 * sends the three fields together.
 */
export function RetakesSetting({
  detail,
  patch,
  disabled,
}: {
  detail: EvaluationDetail;
  patch: ReturnType<typeof useEvaluationPatch>;
  disabled: boolean;
}) {
  const t = useT();
  const retakes = retakesOf(detail.evaluation.settings);
  const set = (next: Partial<RetakeSettings>) =>
    patch.mutate({ settings: { retakes: { ...retakes, ...next } } });

  // The maximum is typed, then committed on blur: empty is "no limit".
  const [max, setMax] = useState(retakes.maxAttempts === null ? "" : String(retakes.maxAttempts));
  useEffect(() => {
    setMax(retakes.maxAttempts === null ? "" : String(retakes.maxAttempts));
  }, [retakes.maxAttempts]);
  const commitMax = () => {
    const trimmed = max.trim();
    if (trimmed === "") {
      if (retakes.maxAttempts !== null) set({ maxAttempts: null });
      return;
    }
    const n = Math.round(Number(trimmed));
    if (!Number.isFinite(n) || n < 2) {
      setMax(retakes.maxAttempts === null ? "" : String(retakes.maxAttempts));
      return;
    }
    const bounded = Math.min(n, 100);
    if (bounded !== retakes.maxAttempts) set({ maxAttempts: bounded });
  };

  return (
    <Card className="divide-y divide-line px-4">
      <SettingRow title={t("eval.retakes")} desc={t("eval.retakes.desc")}>
        <Switch
          checked={retakes.enabled}
          disabled={disabled}
          label={t("eval.retakes")}
          onChange={(enabled) => set({ enabled })}
        />
      </SettingRow>
      {retakes.enabled ? (
        <>
          <SettingRow title={t("eval.retakes.keep")} desc={t("eval.retakes.keep.desc")}>
            <Segmented
              name="retakes-keep"
              value={retakes.keep}
              disabled={disabled}
              onChange={(keep) => set({ keep })}
              options={[
                { value: "best", label: t("eval.retakes.keep.best") },
                { value: "last", label: t("eval.retakes.keep.last") },
              ]}
            />
          </SettingRow>
          <SettingRow title={t("eval.retakes.max")} desc={t("eval.retakes.max.desc")}>
            {/* The row's title is the label: a Field would repeat it. */}
            <input
              aria-label={t("eval.retakes.max")}
              type="number"
              min={2}
              max={100}
              placeholder={t("eval.retakes.max.placeholder")}
              disabled={disabled}
              className={cx(inputClass, inputSize.sm, "w-28 text-right tabular-nums")}
              value={max}
              onChange={(e) => setMax(e.target.value)}
              onBlur={commitMax}
            />
          </SettingRow>
        </>
      ) : null}
    </Card>
  );
}
