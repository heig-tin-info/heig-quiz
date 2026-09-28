import { Check, Lock, MonitorPlay, Timer } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { TransitionRefusal, type EvaluationDetail, type EvaluationPatch } from "@quiz/contracts";
import { configLock, isConfigFieldWritable } from "@quiz/domain";

import { ApiError } from "../api";
import type { Dict } from "../i18n";
import { useT, type TFunction } from "../i18n";
import {
  Alert,
  Badge,
  Button,
  Card,
  cx,
  Field,
  FormError,
  isoDateTime,
  SectionHeading,
  Segmented,
  SettingRow,
} from "../ui";
import { AccessCodeRow, AdvancedDisclosure } from "./AdvancedDisclosure";
import { transitionErrorMessage } from "./LaunchStep";
import type { ConfigPatch, ConfigView } from "./editTarget";
import { RetakesSetting } from "./RetakesSetting";
import { matchPreset, presetPatch, type PresetId } from "./presets";
import { presetSummary } from "./presetSummary";
import {
  fromLocalInput,
  missingTiming,
  missingTimingKey,
  TIMING_FIELD_ID,
  toLocalInput,
  type TimingField,
} from "./timing";
import type { ConfigWriter } from "./usePatch";

/**
 * Step 2 of the novice flow: WHEN, and under what rules.
 *
 * Two named presets carry the whole screen (docs/spec/08 §8.2). They are
 * cards and not a segmented control: each one needs a sentence to be picked
 * without guessing, and a sentence does not fit in a pill. Everything a
 * preset decided stays visible and editable underneath — a preset is a
 * starting point, never a mode.
 *
 * The step is two layers. `ConfigSettings` is the configuration an
 * evaluation and a template share — the presets, the timing kind and the
 * duration, the retakes, the advanced options — and `TimingStep` wraps it
 * with what only a run has: its dates, its access code, the locks of a
 * started evaluation and the fields the launch still needs. A template's
 * editor wraps the same `ConfigSettings` with none of that (F-EVAL-25).
 */

/**
 * One preset. The card in force says what IS set — `summary`, built from the
 * values below it (#87) — and the others what picking them would set.
 */
function PresetCard({
  id,
  active,
  summary,
  onPick,
  disabled,
}: {
  id: PresetId;
  active: boolean;
  summary: string;
  onPick: () => void;
  disabled: boolean;
}) {
  const t = useT();
  // A real <button> and not a `Card` made clickable: a preset is an action,
  // it needs Enter and Space and a pressed state, and `Card` takes neither.
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
        {active ? <Check className="size-4 text-accent" /> : null}
        {t(`eval.preset.${id}` as keyof Dict)}
      </span>
      <span className="mt-1 block text-[13px] text-fg-muted">
        {active ? summary : t(`eval.preset.desc.${id}` as keyof Dict)}
      </span>
    </button>
  );
}

/**
 * The line under a field the launch needs (#76): quiet until the teacher has
 * tried to go on to the launch step, then one sentence that says what to
 * enter, tied to the control by `aria-describedby`.
 */
function MissingNote({ field }: { field: TimingField }) {
  const t = useT();
  return (
    <p id={`${TIMING_FIELD_ID[field]}-missing`} className="max-w-52 text-[13px] text-danger">
      {t(missingTimingKey(field))}
    </p>
  );
}

/** `aria-invalid` and the note's id, for a control whose field is missing (#76). */
function invalid(missing: ReadonlySet<TimingField>, field: TimingField) {
  return missing.has(field)
    ? { "aria-invalid": true, "aria-describedby": `${TIMING_FIELD_ID[field]}-missing` }
    : {};
}

/**
 * A date of the timing, written when the teacher leaves the field (#178).
 * A `datetime-local` reports a complete value at every keystroke of the year
 * — 0002, 0020, 0202 — each one a past time the server refuses on a
 * scheduled evaluation. Keyed on the stored value by its caller, so a write
 * from elsewhere replaces what the field shows; a refused write puts the
 * stored value back (#254), so no field shows a time the server never took.
 */
function DateField({
  value,
  onCommit,
  ...field
}: {
  id: string;
  label: string;
  disabled: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
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
 * A refused patch that would leave a scheduled evaluation unable to start
 * (#178, #254), in the teacher's words: a time already past, or a time
 * cleared. Null for any other error, which `FormError` says.
 */
function scheduleRefusal(error: unknown, t: TFunction): string | null {
  if (!(error instanceof ApiError)) return null;
  const reason = TransitionRefusal.safeParse(error.body).data?.reason;
  if (reason === "opens_at_past" || reason === "closes_at_past") return t("launch.schedule.past");
  if (reason === "timing_incomplete" || reason === "opens_at_missing") {
    return transitionErrorMessage(error, t);
  }
  return null;
}

/**
 * The configuration an evaluation and a template share. What a run adds is
 * handed in: `dates` sits in the timing card beside the duration, and
 * `advancedRows` among the advanced options.
 */
export function ConfigSettings({
  config,
  totalPoints,
  patch,
  presetOf,
  summary,
  disabled = false,
  feedbackDisabled = disabled,
  missing = new Set(),
  dates,
  advancedRows,
}: {
  config: ConfigView;
  totalPoints: number;
  patch: ConfigPatch;
  /** The body a preset card sends: an evaluation's carries dates, a template's cannot. */
  presetOf: (id: PresetId) => Parameters<ConfigPatch["mutate"]>[0];
  /** What the matched preset's card says is in force (#87). */
  summary: string;
  disabled?: boolean;
  feedbackDisabled?: boolean;
  /** The timing fields the launch still needs (#76); none on arrival. */
  missing?: ReadonlySet<TimingField>;
  dates?: ReactNode;
  advancedRows?: ReactNode;
}) {
  const t = useT();
  const { settings, durationS, mode } = config;
  const preset = matchPreset(settings);
  // Empty while nothing is stored: a "45" the server does not have was a
  // duration the teacher believed set, and the waiting room then refused to
  // open for want of it (#76). The 45 stays, as a placeholder.
  const [minutes, setMinutes] = useState(
    durationS === null ? "" : String(Math.round(durationS / 60)),
  );
  useEffect(() => {
    if (durationS !== null) setMinutes(String(Math.round(durationS / 60)));
  }, [durationS]);

  return (
    <>
      <div className="flex flex-wrap gap-3">
        {(["classroom", "homework"] as const).map((id) => (
          <PresetCard
            key={id}
            id={id}
            active={preset === id}
            summary={summary}
            disabled={disabled}
            onPick={() => patch.mutate(presetOf(id))}
          />
        ))}
      </div>

      <Card className="divide-y divide-line px-4">
        <SettingRow
          title={t("eval.timing")}
          desc={
            <>
              {t(`eval.timing.desc.${settings.timing}` as keyof Dict)}
              {missing.has("timing") ? (
                <span id={`${TIMING_FIELD_ID.timing}-missing`} className="mt-0.5 block text-danger">
                  {t(missingTimingKey("timing"))}
                </span>
              ) : null}
            </>
          }
        >
          <div id={TIMING_FIELD_ID.timing}>
            <Segmented
              name="timing"
              value={settings.timing}
              disabled={disabled}
              onChange={(timing) => patch.mutate({ settings: { timing } })}
              options={[
                { value: "duration", label: t("eval.timing.duration") },
                { value: "deadline", label: t("eval.timing.deadline") },
                { value: "manual", label: t("eval.timing.manual") },
              ]}
            />
          </div>
        </SettingRow>

        {/* The dates and the duration share one labelled row: inside a
            settings row they would repeat the row's own title, and a
            segmented control plus a field do not fit a phone's width. */}
        <div className="flex flex-wrap gap-4 py-3">
          {settings.timing === "duration" ? (
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
              {missing.has("durationS") ? <MissingNote field="durationS" /> : null}
            </div>
          ) : null}
          {dates}
        </div>
      </Card>

      {/* F-EVAL-15: an exercise only; an exam is one sitting. */}
      {mode === "exercise" ? (
        <RetakesSetting settings={settings} patch={patch} disabled={disabled} />
      ) : null}

      <AdvancedDisclosure
        config={config}
        totalPoints={totalPoints}
        patch={patch}
        disabled={disabled}
        feedbackDisabled={feedbackDisabled}
      >
        {advancedRows}
      </AdvancedDisclosure>
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
  const { settings, opensAt, closesAt, mode, state, accessCode } = detail.evaluation;
  // Structural settings freeze once somebody has started (W5-17), and the
  // whole configuration while the evaluation runs (#86) — the server says so
  // in `editable`, the domain says which fields stay writable.
  const locked = !detail.editable;
  const lock = configLock(state, detail.attemptCount);
  const summary = presetSummary(detail.evaluation, t, isoDateTime);
  const missing = new Set(showMissing ? missingTiming(detail.evaluation) : []);
  const refusal = scheduleRefusal(patch.error, t);

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
        totalPoints={detail.totalPoints}
        patch={patch}
        presetOf={(id) => presetPatch(id, mode)}
        summary={summary}
        disabled={locked}
        feedbackDisabled={!isConfigFieldWritable(lock, "feedbackPolicy")}
        missing={missing}
        dates={
          <>
            <div className="flex flex-col gap-1">
              <DateField
                key={opensAt ?? ""}
                id={TIMING_FIELD_ID.opensAt}
                {...invalid(missing, "opensAt")}
                label={t("eval.opensAt")}
                disabled={locked}
                value={opensAt}
                onCommit={(value, reset) => patch.mutate({ opensAt: value }, { onError: reset })}
              />
              {missing.has("opensAt") ? <MissingNote field="opensAt" /> : null}
            </div>
            {settings.timing !== "manual" ? (
              <div className="flex flex-col gap-1">
                <DateField
                  key={closesAt ?? ""}
                  id={TIMING_FIELD_ID.closesAt}
                  {...invalid(missing, "closesAt")}
                  label={t("eval.closesAt")}
                  disabled={locked}
                  value={closesAt}
                  onCommit={(value, reset) => patch.mutate({ closesAt: value }, { onError: reset })}
                />
                {missing.has("closesAt") ? <MissingNote field="closesAt" /> : null}
              </div>
            ) : null}
          </>
        }
        advancedRows={<AccessCodeRow accessCode={accessCode} patch={patch} />}
      />
    </div>
  );
}
