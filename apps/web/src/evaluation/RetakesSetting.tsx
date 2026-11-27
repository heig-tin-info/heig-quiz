import { useEffect, useState } from "react";

import { retakesOf, type EvaluationSettings, type RetakeSettings } from "@quiz/contracts";
import { retakeScopeFits, retakeScopeOf, retakesWidening, type EvaluationModeName } from "@quiz/domain";

import { useT } from "../i18n";
import { Button, Card, Segmented, SettingRow, Switch, TextInput } from "../ui";
import type { ConfigPatch } from "./editTarget";

/**
 * F-EVAL-15 (ADR-025): several attempts on an exercise.
 *
 * Shown for an exercise only — the server refuses the setting on an exam —
 * and frozen like the rest of the structure once somebody has started. One
 * switch; the two details it brings (which attempt counts, how many) appear
 * only once it is on, so a teacher who never wants retakes reads one line.
 *
 * The rule travels whole (`EvaluationSettingsPatch.retakes`): every change
 * sends its fields together.
 *
 * ADR-091: what a retake asks again — every question, or only those to
 * review. The second needs free navigation (the server refuses the pair,
 * `422 retake_scope_navigation`): under another navigation the choice is
 * disabled and says why, and once it is on, the navigation row says why it
 * cannot move (`AdvancedDisclosure`).
 *
 * ADR-025 §2 (amended 2026-11-27): while the exercise runs (`widenOnly`),
 * the rule may only widen (`retakesWidening`, the server's rule too). The
 * switch turns it on, never off; the kept attempt and the scope are chosen
 * at that moment only, so switching it on opens an unsaved draft of the
 * whole rule, sent by Save; once on, only the maximum moves, upwards.
 */
export function RetakesSetting({
  mode,
  settings,
  patch,
  disabled,
  widenOnly = false,
}: {
  /** The evaluation's mode: the rules read it (`retakeScopeFits`). */
  mode: EvaluationModeName;
  settings: EvaluationSettings;
  patch: ConfigPatch;
  disabled: boolean;
  /** Students are sitting the exercise: the rule may only widen (`retakesWidenableUnder`). */
  widenOnly?: boolean;
}) {
  const t = useT();
  const stored = retakesOf(settings);
  // The rule switched on under the lock, not saved yet: its details are chosen now or never.
  const [draft, setDraft] = useState<RetakeSettings | null>(null);
  const retakes = draft ?? stored;
  const scope = retakeScopeOf(retakes);
  // The server's pairing rule, asked of `to_review` under this navigation;
  // a scope already at `to_review` can always be set back to `all`.
  const scopeLocked =
    scope === "all" && !retakeScopeFits(mode, { ...retakes, scope: "to_review" }, settings.navigation);
  // Whether a change is one the screen may make: anything outside the lock
  // and inside a draft, a widening of the stored rule otherwise.
  const allows = (next: Partial<RetakeSettings>) =>
    !widenOnly || draft !== null || retakesWidening(stored, { ...stored, ...next });
  const frozen = (next: Partial<RetakeSettings>) => (widenOnly ? !allows(next) : disabled);
  const set = (next: Partial<RetakeSettings>) => {
    if (draft !== null) setDraft({ ...draft, ...next });
    else patch.mutate({ settings: { retakes: { ...stored, ...next } } });
  };
  const toggle = (enabled: boolean) => {
    if (widenOnly) setDraft(enabled ? { ...stored, enabled: true } : null);
    else set({ enabled });
  };

  // The maximum is typed, then committed on blur: empty is "no limit".
  const shownMax = (value: number | null) => (value === null ? "" : String(value));
  const [max, setMax] = useState(shownMax(retakes.maxAttempts));
  useEffect(() => {
    setMax(shownMax(retakes.maxAttempts));
  }, [retakes.maxAttempts]);
  const commitMax = () => {
    const trimmed = max.trim();
    const n = Math.round(Number(trimmed));
    const next = trimmed === "" ? null : Number.isFinite(n) && n >= 2 ? Math.min(n, 100) : undefined;
    if (next === undefined || !allows({ maxAttempts: next })) {
      setMax(shownMax(retakes.maxAttempts));
      return;
    }
    if (next !== retakes.maxAttempts) set({ maxAttempts: next });
  };

  const desc = widenOnly ? `${t("eval.retakes.desc")} ${t("eval.retakes.widenOnly")}` : t("eval.retakes.desc");
  return (
    <Card className="divide-y divide-line px-4">
      <SettingRow title={t("eval.retakes")} desc={desc}>
        <Switch
          checked={retakes.enabled}
          disabled={frozen({ enabled: !retakes.enabled })}
          label={t("eval.retakes")}
          onChange={toggle}
        />
      </SettingRow>
      {retakes.enabled ? (
        <>
          <SettingRow title={t("eval.retakes.keep")}>
            <Segmented
              name="retakes-keep"
              value={retakes.keep}
              disabled={frozen({ keep: retakes.keep === "best" ? "last" : "best" })}
              onChange={(keep) => set({ keep })}
              options={[
                { value: "best", label: t("eval.retakes.keep.best") },
                { value: "last", label: t("eval.retakes.keep.last") },
              ]}
            />
          </SettingRow>
          <SettingRow title={t("eval.retakes.max")} desc={t("eval.retakes.max.desc")}>
            {/* The row's title is the label: a Field would repeat it. No
                limit is the widest rule: under the lock, nothing is above it. */}
            <TextInput
              aria-label={t("eval.retakes.max")}
              type="number"
              min={widenOnly && draft === null ? (stored.maxAttempts ?? 2) : 2}
              max={100}
              placeholder={t("eval.retakes.max.placeholder")}
              disabled={widenOnly ? draft === null && stored.maxAttempts === null : disabled}
              size="sm"
              className="w-28 text-right tabular-nums"
              value={max}
              onChange={(e) => setMax(e.target.value)}
              onBlur={commitMax}
            />
          </SettingRow>
          <SettingRow
            title={t("eval.retakes.scope")}
            desc={
              scopeLocked
                ? `${t("eval.retakes.scope.desc")} ${t("eval.retakes.scope.needsFree")}`
                : t("eval.retakes.scope.desc")
            }
          >
            <Segmented
              name="retakes-scope"
              value={scope}
              disabled={frozen({ scope: scope === "all" ? "to_review" : "all" }) || scopeLocked}
              onChange={(next) => set({ scope: next })}
              options={[
                { value: "all", label: t("eval.retakes.scope.all") },
                { value: "to_review", label: t("eval.retakes.scope.to_review") },
              ]}
            />
          </SettingRow>
          {draft !== null ? (
            <div className="flex justify-end py-3">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => patch.mutate({ settings: { retakes: draft } }, { onSuccess: () => setDraft(null) })}
              >
                {t("common.save")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
