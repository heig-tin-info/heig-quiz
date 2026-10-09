import { CalendarClock, Check, Lock, MonitorPlay, Radio, Timer } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { TransitionRefusal, type EvaluationDetail, type EvaluationPatch } from "@quiz/contracts";
import {
  clockChoiceOf,
  clockFields,
  clockPatch,
  CLOCK_MODES,
  conditionsAllowedFor,
  configLock,
  isConfigFieldWritable,
  type ClockChoice,
  type ClockMode,
  type EvaluationTiming,
} from "@quiz/domain";

import { ApiError } from "../api";
import { EvaluationDrillSetting } from "../drill/EvaluationDrillSetting";
import { useT } from "../i18n";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  FieldError,
  fieldErrorProps,
  Field,
  FormError,
  isoDateTime,
  SectionHeading,
  SettingRow,
  Switch,
  type IconType,
} from "../ui";
import { AdvancedDisclosure, withFeedbackFallback } from "./AdvancedDisclosure";
import { clockSummary } from "./clockSummary";
import { ConditionsSetting } from "./ConditionsSetting";
import type { ConfigPatch, ConfigView } from "./editTarget";
import { RetakesSetting } from "./RetakesSetting";
import {
  fromLocalInput,
  missingTiming,
  missingTimingKey,
  TIMING_FIELD_ID,
  toLocalInput,
  transitionErrorMessage,
  type TimingField,
} from "./timing";
import type { ConfigWriter } from "./usePatch";

/**
 * Step 2 of the novice flow: WHEN, and under what rules.
 *
 * One question carries the time (ADR-086, #555): who drives the clock?
 * Scheduled — the platform opens and closes it between two dates — or Live —
 * the teacher starts it from the waiting room and closes it. Then one
 * switch: a time limit per student, or none. The stored `timing` and `lobby`
 * are derived from the two answers (`clockPatch`, `@quiz/domain`) and read
 * back from them (`clockChoiceOf`), so nothing new is stored. The two modes
 * are cards and not a segmented control: each needs a sentence to be picked
 * without guessing, and a sentence does not fit in a pill.
 *
 * The step is two layers. `ConfigSettings` is the configuration an
 * evaluation and a template share — the mode, the limit, the retakes, the
 * conditions (ADR-079), the advanced options — and `TimingStep` wraps it
 * with what only a run has: its dates, the locks of a started evaluation
 * and the fields the launch still needs. A template's editor wraps the same
 * `ConfigSettings` with none of that (F-EVAL-25).
 */

const MODE_ICON: Record<ClockMode, IconType> = { scheduled: CalendarClock, live: Radio };

/**
 * One mode. The card in force says what IS set — `summary`, built from the
 * values below it (#87) — and the other what picking it means.
 */
function ModeCard({
  mode,
  active,
  summary,
  onPick,
  disabled,
}: {
  mode: ClockMode;
  active: boolean;
  summary: string;
  onPick: () => void;
  disabled: boolean;
}) {
  const t = useT();
  const Icon = active ? Check : MODE_ICON[mode];
  // A real <button> and not a `Card` made clickable: picking a mode is an
  // action, it needs Enter and Space and a pressed state, and `Card` takes
  // neither.
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      aria-pressed={active}
      className={cx(
        "flex-1 basis-64 rounded-card border bg-surface px-4 py-3 text-left transition-colors",
        disabled
          ? "border-line opacity-60"
          : active
            ? "border-accent bg-accent-soft"
            : "border-line hover:border-line-strong",
      )}
    >
      <span className="flex items-center gap-2 font-semibold">
        <Icon className={cx("size-4", active ? "text-accent" : "text-fg-faint")} aria-hidden />
        {t(`eval.clock.${mode}`)}
      </span>
      <span className="mt-1 block text-[13px] text-fg-muted">
        {active ? summary : t(`eval.clock.desc.${mode}`)}
      </span>
    </button>
  );
}

/**
 * The line under a field the launch needs (#76): quiet until the teacher has
 * tried to go on to the launch step, then one sentence that says what to
 * enter, tied to the control by `aria-describedby` (`FieldError`).
 */
function MissingNote({ field, timing }: { field: TimingField; timing: EvaluationTiming }) {
  const t = useT();
  return (
    <FieldError id={TIMING_FIELD_ID[field]} className="max-w-52">
      {t(missingTimingKey(field, timing))}
    </FieldError>
  );
}

/** `aria-invalid` and the note's id, for a control whose field is missing (#76). */
function invalid(missing: ReadonlySet<TimingField>, field: TimingField) {
  return fieldErrorProps(TIMING_FIELD_ID[field], missing.has(field) ? field : null);
}

/**
 * A date of the timing, written when the teacher leaves the field (#178).
 * A `datetime-local` reports a complete value at every keystroke of the year
 * — 0002, 0020, 0202 — each one a past time the server refuses on a
 * scheduled evaluation. Keyed on the stored value by its caller, so a write
 * from elsewhere replaces what the field shows; a refused write puts the
 * stored value back (#254), so no field shows a time the server never took.
 * A project's deadline and a repository's own deadline (M3-12) are written
 * the same way.
 */
export function DateField({
  value,
  onCommit,
  ...field
}: {
  id: string;
  label: string;
  disabled: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  /** What the date means, one line under the input (the project page's deadline). */
  description?: ReactNode;
  value: string | null;
  /** Writes the value; `reset` is for a refusal, to show the stored value again. */
  onCommit: (value: string | null, reset: () => void) => void;
}) {
  const [local, setLocal] = useState(() => toLocalInput(value));
  return (
    <Field
      {...field}
      type="datetime-local"
      size="sm"
      width="w-52"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local !== toLocalInput(value)) {
          onCommit(fromLocalInput(local), () => setLocal(toLocalInput(value)));
        }
      }}
    />
  );
}

/**
 * The configuration an evaluation and a template share. What a run adds is
 * handed in: `dates` sits in the timing card beside the minutes, and gets the
 * mode in force so it shows that mode's fields (ADR-086 §1).
 */
export function ConfigSettings({
  config,
  courseId,
  patch,
  summary,
  disabled = false,
  feedbackDisabled = disabled,
  missing = new Set(),
  dates,
  closesAt = null,
  holdsCategorize = false,
}: {
  config: ConfigView;
  /** The course of the evaluation or the template: its catalog of conditions (F-ORG-16). */
  courseId: string;
  patch: ConfigPatch;
  /** What the card of the mode in force says (#87). */
  summary: string;
  disabled?: boolean;
  feedbackDisabled?: boolean;
  /** The timing fields the launch still needs (#76); none on arrival. */
  missing?: ReadonlySet<TimingField>;
  dates: (choice: ClockChoice) => ReactNode;
  /** The run's end, for the conditions' deadline line (ADR-079); a template has none. */
  closesAt?: string | null;
  /** An item is a `categorize` question: its policy row is shown (ADR-036). */
  holdsCategorize?: boolean;
}) {
  const t = useT();
  const { settings, durationS, mode } = config;
  const choice = clockChoiceOf(settings);
  // Empty while nothing is stored: a "45" the server does not have was a
  // duration the teacher believed set, and the waiting room then refused to
  // open for want of it (#76). The 45 stays, as a placeholder.
  const [minutes, setMinutes] = useState(
    durationS === null ? "" : String(Math.round(durationS / 60)),
  );
  useEffect(() => {
    if (durationS !== null) setMinutes(String(Math.round(durationS / 60)));
  }, [durationS]);

  /*
   * One patch per choice: the two settings and the limit it starts from,
   * with the feedback fallback a waiting room gained needs (#78).
   */
  const choose = (next: ClockChoice) =>
    patch.mutate(withFeedbackFallback(config, clockPatch(next, { ...settings, durationS })));

  return (
    <>
      {/* The question itself, said once above its two answers. */}
      <div role="group" aria-labelledby="eval-clock" className="space-y-2">
        <p id="eval-clock" className="text-sm font-medium">
          {t("eval.clock")}
        </p>
        <div className="flex flex-wrap gap-3">
          {CLOCK_MODES.map((m) => (
            <ModeCard
              key={m}
              mode={m}
              active={choice.mode === m}
              summary={summary}
              disabled={disabled}
              onPick={() => {
                if (choice.mode !== m) choose({ mode: m, limited: choice.limited });
              }}
            />
          ))}
        </div>
      </div>

      <Card className="divide-y divide-line px-4">
        <SettingRow
          title={t("eval.limit")}
          desc={t(choice.limited ? `eval.limit.desc.${choice.mode}` : `eval.limit.off.${choice.mode}`)}
        >
          <Switch
            checked={choice.limited}
            disabled={disabled}
            label={t("eval.limit")}
            onChange={(limited) => choose({ mode: choice.mode, limited })}
          />
        </SettingRow>

        {/* The minutes and the dates share one row: inside a settings row
            they would repeat the row's own title, and a field per row does
            not fit a phone's width. */}
        <div className="flex flex-wrap gap-4 py-3">
          {clockFields(choice).includes("durationS") ? (
            <div className="flex flex-col gap-1">
              <Field
                id={TIMING_FIELD_ID.durationS}
                {...invalid(missing, "durationS")}
                placeholder="45"
                label={t("eval.duration")}
                type="number"
                min={1}
                max={480}
                size="sm"
                width="w-24"
                disabled={disabled}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                onBlur={() => {
                  const n = Number(minutes);
                  if (!Number.isFinite(n) || n < 1) return;
                  const next = Math.round(n) * 60;
                  if (next !== durationS) patch.mutate({ durationS: next });
                }}
                className="text-right tabular-nums"
              />
              {missing.has("durationS") ? <MissingNote field="durationS" timing={settings.timing} /> : null}
            </div>
          ) : null}
          {dates(choice)}
        </div>
      </Card>

      {/* F-EVAL-15: an exercise only; an exam is one sitting. */}
      {mode === "exercise" ? (
        <RetakesSetting mode={mode} settings={settings} patch={patch} disabled={disabled} />
      ) : null}

      {/* ADR-079: an exam or an exercise announces its conditions; a poll has none. */}
      {conditionsAllowedFor(mode) ? (
        <ConditionsSetting config={config} courseId={courseId} closesAt={closesAt} patch={patch} disabled={disabled} />
      ) : null}

      <AdvancedDisclosure
        config={config}
        patch={patch}
        disabled={disabled}
        feedbackDisabled={feedbackDisabled}
        holdsCategorize={holdsCategorize}
      />
    </>
  );
}

export function TimingStep({
  detail,
  patch,
  showMissing = false,
  onOpenDashboard,
}: {
  detail: EvaluationDetail;
  patch: ConfigWriter<EvaluationPatch>;
  /** Where time is added while the evaluation runs (#86). */
  onOpenDashboard?: () => void;
  /**
   * The teacher asked for the launch step with the timing incomplete: every
   * field the server would refuse the waiting room for is marked, until it is
   * filled. Off until then — an empty form is not an error on arrival.
   */
  showMissing?: boolean;
}) {
  const t = useT();
  const { settings, opensAt, closesAt, mode, state } = detail.evaluation;
  // Structural settings freeze once somebody has started (W5-17), and the
  // whole configuration while the evaluation runs (#86) — the server says so
  // in `editable`, the domain says which fields stay writable.
  const locked = !detail.editable;
  const lock = configLock(state, detail.attemptCount);
  const summary = clockSummary(detail.evaluation, t, isoDateTime);
  const missing = new Set(showMissing ? missingTiming(detail.evaluation) : []);
  // A refused date (#178, #254) in the teacher's words; any other error is FormError's.
  const refusal = TransitionRefusal.safeParse(
    patch.error instanceof ApiError ? patch.error.body : undefined,
  ).success
    ? transitionErrorMessage(patch.error, t, settings.timing)
    : null;

  /*
   * The dates of the mode in force (ADR-086 §1). Scheduled: the window the
   * platform opens and closes. Live: a date for the calendar only — nothing
   * opens by itself — and the optional safety deadline the
   * ticker closes on (required for an exam without a limit: it must end by
   * itself).
   */
  const dates = (choice: ClockChoice) => {
    const live = choice.mode === "live";
    const date = (field: "opensAt" | "closesAt", value: string | null, label: string, description?: string) => (
      <div className="flex flex-col gap-1">
        <DateField
          key={value ?? ""}
          id={TIMING_FIELD_ID[field]}
          {...invalid(missing, field)}
          label={label}
          description={description}
          disabled={locked}
          value={value}
          onCommit={(next, reset) => patch.mutate({ [field]: next }, { onError: reset })}
        />
        {missing.has(field) ? <MissingNote field={field} timing={settings.timing} /> : null}
      </div>
    );
    return (
      <>
        {live
          ? date("opensAt", opensAt, t("eval.liveDate"), t("eval.liveDate.desc"))
          : date("opensAt", opensAt, t("eval.opensAt"))}
        {clockFields(choice).includes("closesAt")
          ? live
            ? date(
                "closesAt",
                closesAt,
                t("eval.safetyDeadline"),
                t(mode === "exam" && !choice.limited ? "eval.safetyDeadline.descExam" : "eval.safetyDeadline.desc"),
              )
            : date("closesAt", closesAt, t("eval.closesAt"))
          : null}
      </>
    );
  };

  return (
    <div className="space-y-5">
      <SectionHeading
        icon={Timer}
        title={t("eval.step.timing")}
        description={t("eval.step.timing.desc")}
        actions={<Badge tone="zinc">{t(`eval.mode.${mode}`)}</Badge>}
      />

      {lock === "running" ? (
        <Alert
          tone="warning"
          icon={Lock}
          title={t("eval.lockedRunning")}
          action={
            onOpenDashboard ? (
              <Button size="sm" variant="secondary" onClick={onOpenDashboard}>
                <MonitorPlay /> {t("eval.dashboard")}
              </Button>
            ) : null
          }
        >
          {t("eval.lockedRunning.body")}
        </Alert>
      ) : locked ? (
        <Alert tone="warning" title={t("eval.locked")} />
      ) : null}
      {refusal ? (
        <Alert tone="danger" title={t("eval.saveFailed")}>
          {refusal}
        </Alert>
      ) : (
        <FormError error={patch.error} title={t("eval.saveFailed")} />
      )}

      <ConfigSettings
        config={detail.evaluation}
        courseId={detail.courseId}
        patch={patch}
        summary={summary}
        disabled={locked}
        feedbackDisabled={!isConfigFieldWritable(lock, "feedbackPolicy")}
        holdsCategorize={detail.items.some((i) => i.type === "categorize")}
        missing={missing}
        closesAt={closesAt}
        dates={dates}
      />

      {/* ADR-041 §2 (#317): its own writer, editable until the release —
          not one of the settings `patch` saves, nor frozen with them. */}
      {mode !== "poll" ? <EvaluationDrillSetting evaluation={detail.evaluation} /> : null}
    </div>
  );
}
