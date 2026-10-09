import { useEffect, useRef } from "react";

import { retakesOf, type EvaluationMode } from "@quiz/contracts";
import { retakesAllowedFor } from "@quiz/domain";

import { useConfirm } from "../confirm";
import { useT, type TFunction } from "../i18n";
import { useToast } from "../notify";
import { Badge, Segmented } from "../ui";
import type { ConfigPatch, ConfigView } from "./editTarget";

/** The two modes a new evaluation or a new template can take: a poll is neither. */
export type CreatedMode = Exclude<EvaluationMode, "poll">;

/** The two pills, written once for the creation dialogs and the configuration. */
const modeOptions = (t: TFunction, disabledExam = false, title?: string) => [
  { value: "exam" as const, label: t("eval.mode.exam"), disabled: disabledExam, ...(disabledExam && title ? { title } : {}) },
  { value: "exercise" as const, label: t("eval.mode.exercise") },
];

/**
 * The mode of a new evaluation or a new template, with the sentence that
 * says what it implies. The mode also names the preset the creation sends
 * (`preset: mode`), so what the sentence promises is what the server sets.
 * One control for the two creation dialogs, so they cannot word it apart.
 */
export function ModeChoice({
  value,
  onChange,
}: {
  value: CreatedMode;
  onChange: (mode: CreatedMode) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <span className="text-[13px] font-medium">{t("eval.mode")}</span>
      <div>
        <Segmented name="eval-mode" label={t("eval.mode")} value={value} onChange={onChange} options={modeOptions(t)} />
      </div>
      <p className="text-[13px] text-fg-muted">{t(`eval.mode.desc.${value}`)}</p>
    </div>
  );
}

/**
 * The mode in the header of the configuration (ADR-092): a Segmented control
 * while it can still change — a draft or scheduled evaluation nobody has
 * attempted, or a template (`modeChangeable`, `@quiz/domain`) — and the badge
 * it always was otherwise.
 *
 * Only the mode moves: the server reapplies no preset. The exam option is
 * disabled while retakes are on and an exam refuses them (the teacher turns
 * them off first); a scheduled evaluation asks first, since its card is
 * already on the students' screens; and the one setting the server forces
 * (`immediate` feedback does not exist in an exam) is said in a note, read
 * from the refreshed configuration, not guessed before the answer.
 */
export function ModeControl({
  config,
  changeable,
  scheduled = false,
  patch,
}: {
  config: ConfigView;
  changeable: boolean;
  /** Students already see this evaluation with its mode: ask before changing it. */
  scheduled?: boolean;
  patch: ConfigPatch;
}) {
  const t = useT();
  const confirm = useConfirm();
  const toast = useToast();
  const { mode, settings, feedbackPolicy } = config;

  // The note: the mode just changed and the server moved the feedback with it.
  const seen = useRef({ mode, when: feedbackPolicy.when });
  useEffect(() => {
    if (seen.current.mode !== mode && seen.current.when !== feedbackPolicy.when) toast(t("eval.mode.feedbackFell"), "info");
    seen.current = { mode, when: feedbackPolicy.when };
  }, [mode, feedbackPolicy.when, toast, t]);

  if (!changeable || mode === "poll") return <Badge tone="zinc">{t(`eval.mode.${mode}`)}</Badge>;

  const retakes = retakesOf(settings).enabled && !retakesAllowedFor("exam");
  const hint = t("eval.mode.retakesFirst");
  const change = async (next: CreatedMode) => {
    if (next === mode) return;
    if (
      scheduled &&
      !(await confirm({
        title: t("eval.mode.confirm.title"),
        message: t("eval.mode.confirm.message", { mode: t(`eval.mode.${next}`) }),
        confirmLabel: t("eval.mode.confirm.action", { mode: t(`eval.mode.${next}`) }),
      }))
    ) {
      return;
    }
    patch.mutate({ mode: next });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Segmented
        name="eval-mode-change"
        label={t("eval.mode")}
        value={mode}
        onChange={(next) => void change(next)}
        options={modeOptions(t, retakes, hint)}
      />
      {retakes ? <span className="text-xs text-fg-muted">{hint}</span> : null}
    </div>
  );
}
