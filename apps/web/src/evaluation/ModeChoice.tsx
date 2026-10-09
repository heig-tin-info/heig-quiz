import { retakesOf, type EvaluationMode } from "@quiz/contracts";
import { modeChangeEffects } from "@quiz/domain";

import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Badge, Segmented } from "../ui";
import type { ConfigPatch, ConfigView } from "./editTarget";

/** The two modes a new evaluation or a new template can take: a poll is neither. */
export type CreatedMode = Exclude<EvaluationMode, "poll">;

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
        <Segmented
          name="eval-mode"
          label={t("eval.mode")}
          value={value}
          onChange={onChange}
          options={[
            { value: "exam", label: t("eval.mode.exam") },
            { value: "exercise", label: t("eval.mode.exercise") },
          ]}
        />
      </div>
      <p className="text-[13px] text-fg-muted">{t(`eval.mode.desc.${value}`)}</p>
    </div>
  );
}

/**
 * The mode a template brings, read-only, in the dialog that starts an
 * evaluation from it (ADR-092): the copy takes it, and the teacher may
 * change it afterwards in the configuration.
 */
export function TemplateModeLine({ mode }: { mode: EvaluationMode }) {
  const t = useT();
  return <p className="text-[13px] text-fg-muted">{t("templates.modeLine", { mode: t(`eval.mode.${mode}`) })}</p>;
}

/**
 * The mode in the header of the configuration (ADR-092): a Segmented control
 * while it can still change — a draft or scheduled evaluation nobody has
 * attempted, or a template (`modeChangeable`, `@quiz/domain`) — and the badge
 * it always was otherwise.
 *
 * Only the mode moves: the server reapplies no preset. The exam option is
 * disabled while retakes are on (the teacher turns them off first, as the
 * server demands); a scheduled evaluation asks first, since its card is
 * already on the students' screens; and the one setting the change forces
 * (`immediate` feedback does not exist in an exam) is said in a note.
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
  if (!changeable || mode === "poll") return <Badge tone="zinc">{t(`eval.mode.${mode}`)}</Badge>;

  const retakes = retakesOf(settings).enabled;
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
    const effects = modeChangeEffects(mode, next, {
      lobby: settings.lobby,
      feedbackWhen: feedbackPolicy.when,
      allowDrill: settings.allowDrill,
    });
    patch.mutate({ mode: next });
    if (effects.feedbackWhen !== feedbackPolicy.when) toast(t("eval.mode.feedbackFell"), "info");
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Segmented
        name="eval-mode-change"
        label={t("eval.mode")}
        value={mode}
        onChange={(next) => void change(next)}
        options={[
          { value: "exam", label: t("eval.mode.exam"), disabled: retakes, ...(retakes ? { title: hint } : {}) },
          { value: "exercise", label: t("eval.mode.exercise") },
        ]}
      />
      {retakes ? <span className="text-xs text-fg-muted">{hint}</span> : null}
    </div>
  );
}
