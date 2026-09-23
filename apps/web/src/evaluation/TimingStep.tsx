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

export function TimingStep({
  detail,
  patch,
}: {
  detail: EvaluationDetail;
  patch: ReturnType<typeof useEvaluationPatch>;
}) {
  const t = useT();
  const { settings, durationS, opensAt, closesAt, mode } = detail.evaluation;
  // Structural settings freeze once somebody has started (W5-17).
  const locked = !detail.editable;
  const preset = matchPreset(detail);
  const [minutes, setMinutes] = useState(String(Math.round((durationS ?? 45 * 60) / 60)));
  useEffect(() => {
    if (durationS !== null) setMinutes(String(Math.round(durationS / 60)));
  }, [durationS]);

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
            onPick={() => patch.mutate(presetPatch(id))}
          />
        ))}
      </div>

      <Card className="divide-y divide-line px-4">
        <SettingRow
          title={t("eval.timing")}
          desc={t(`eval.timing.desc.${settings.timing}` as keyof Dict)}
        >
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
        </SettingRow>

        {/* The three dates and the duration share one labelled row: inside a
            settings row they would repeat the row's own title, and a
            segmented control plus a field do not fit a phone's width. */}
        <div className="flex flex-wrap gap-4 py-3">
          {settings.timing === "duration" ? (
            <Field
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
          ) : null}
          <Field
            label={t("eval.opensAt")}
            type="datetime-local"
            size="sm"
            width="w-52"
            disabled={locked}
            value={toLocalInput(opensAt)}
            onChange={(e) => patch.mutate({ opensAt: fromLocalInput(e.target.value) })}
          />
          {settings.timing !== "manual" ? (
            <Field
              label={t("eval.closesAt")}
              type="datetime-local"
              size="sm"
              width="w-52"
              disabled={locked}
              value={toLocalInput(closesAt)}
              onChange={(e) => patch.mutate({ closesAt: fromLocalInput(e.target.value) })}
            />
          ) : null}
        </div>
      </Card>

      <AdvancedDisclosure detail={detail} patch={patch} disabled={locked} />
    </div>
  );
}
