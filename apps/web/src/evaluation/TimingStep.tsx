import { Check, Timer } from "lucide-react";
import { useEffect, useState } from "react";

import type { EvaluationDetail } from "@quiz/contracts";

import type { Dict } from "../i18n";
import { useT } from "../i18n";
import {
  Alert,
  Badge,
  Card,
  cx,
  Field,
  FormError,
  SectionHeading,
  Segmented,
  SettingRow,
} from "../ui";
import { AdvancedDisclosure } from "./AdvancedDisclosure";
import { matchPreset, presetPatch, type PresetId } from "./presets";
import { missingTiming, missingTimingKey, TIMING_FIELD_ID, type TimingField } from "./timing";
import type { useEvaluationPatch } from "./usePatch";

/**
 * Step 2 of the novice flow: WHEN, and under what rules.
 *
 * Two named presets carry the whole screen (docs/spec/08 §8.2). They are
 * cards and not a segmented control: each one needs a sentence to be picked
 * without guessing, and a sentence does not fit in a pill. Everything a
 * preset decided stays visible and editable underneath — a preset is a
 * starting point, never a mode.
 */

/** A `datetime-local` value from an ISO instant, in the reader's own zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function PresetCard({
  id,
  active,
  onPick,
  disabled,
}: {
  id: PresetId;
  active: boolean;
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
        {t(`eval.preset.desc.${id}` as keyof Dict)}
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

export function TimingStep({
  detail,
  patch,
  showMissing = false,
}: {
  detail: EvaluationDetail;
  patch: ReturnType<typeof useEvaluationPatch>;
  /**
   * The teacher asked for the launch step with the timing incomplete: every
   * field the server would refuse the waiting room for is marked, until it is
   * filled. Off until then — an empty form is not an error on arrival.
   */
  showMissing?: boolean;
}) {
  const t = useT();
  const { settings, durationS, opensAt, closesAt, mode } = detail.evaluation;
  // Structural settings freeze once somebody has started (W5-17).
  const locked = !detail.editable;
  const preset = matchPreset(detail);
  // Empty while nothing is stored: a "45" the server does not have was a
  // duration the teacher believed set, and the waiting room then refused to
  // open for want of it (#76). The 45 stays, as a placeholder.
  const [minutes, setMinutes] = useState(
    durationS === null ? "" : String(Math.round(durationS / 60)),
  );
  useEffect(() => {
    if (durationS !== null) setMinutes(String(Math.round(durationS / 60)));
  }, [durationS]);
  const missing = new Set(showMissing ? missingTiming(detail.evaluation) : []);
  /** `aria-invalid` and the note's id, for a control whose field is missing. */
  const invalid = (field: TimingField) =>
    missing.has(field)
      ? { "aria-invalid": true, "aria-describedby": `${TIMING_FIELD_ID[field]}-missing` }
      : {};

  return (
    <div className="space-y-5">
      <SectionHeading
        icon={Timer}
        title={t("eval.step.timing")}
        description={t("eval.step.timing.desc")}
        actions={<Badge tone="zinc">{t(`eval.mode.${mode}`)}</Badge>}
      />

      {locked ? <Alert tone="warning" title={t("eval.locked")} /> : null}
      <FormError error={patch.error} title={t("eval.saveFailed")} />

      <div className="flex flex-wrap gap-3">
        {(["classroom", "homework"] as const).map((id) => (
          <PresetCard
            key={id}
            id={id}
            active={preset === id}
            disabled={locked}
            onPick={() => patch.mutate(presetPatch(id, mode))}
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
              disabled={locked}
              onChange={(timing) => patch.mutate({ settings: { timing } })}
              options={[
                { value: "duration", label: t("eval.timing.duration") },
                { value: "deadline", label: t("eval.timing.deadline") },
                { value: "manual", label: t("eval.timing.manual") },
              ]}
            />
          </div>
        </SettingRow>

        {/* The three dates and the duration share one labelled row: inside a
            settings row they would repeat the row's own title, and a
            segmented control plus a field do not fit a phone's width. */}
        <div className="flex flex-wrap gap-4 py-3">
          {settings.timing === "duration" ? (
            <div className="flex flex-col gap-1">
              <Field
                id={TIMING_FIELD_ID.durationS}
                {...invalid("durationS")}
                placeholder="45"
                label={t("eval.duration")}
                type="number"
                min={1}
                max={480}
                size="sm"
                width="w-24"
                disabled={locked}
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
          <div className="flex flex-col gap-1">
            <Field
              id={TIMING_FIELD_ID.opensAt}
              {...invalid("opensAt")}
              label={t("eval.opensAt")}
              type="datetime-local"
              size="sm"
              width="w-52"
              disabled={locked}
              value={toLocalInput(opensAt)}
              onChange={(e) => patch.mutate({ opensAt: fromLocalInput(e.target.value) })}
            />
            {missing.has("opensAt") ? <MissingNote field="opensAt" /> : null}
          </div>
          {settings.timing !== "manual" ? (
            <div className="flex flex-col gap-1">
              <Field
                id={TIMING_FIELD_ID.closesAt}
                {...invalid("closesAt")}
                label={t("eval.closesAt")}
                type="datetime-local"
                size="sm"
                width="w-52"
                disabled={locked}
                value={toLocalInput(closesAt)}
                onChange={(e) => patch.mutate({ closesAt: fromLocalInput(e.target.value) })}
              />
              {missing.has("closesAt") ? <MissingNote field="closesAt" /> : null}
            </div>
          ) : null}
        </div>
      </Card>

      <AdvancedDisclosure detail={detail} patch={patch} disabled={locked} />
    </div>
  );
}
