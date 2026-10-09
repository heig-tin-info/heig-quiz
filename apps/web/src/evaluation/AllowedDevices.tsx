import { kioskOf, safeExamBrowserOf, type EvaluationSettings } from "@quiz/contracts";
import { Shield, ShieldCheck, ShieldHalf, type LucideIcon } from "lucide-react";
import { useId } from "react";

import { useT } from "../i18n";
import { RadioRow } from "../ui";

type Devices = Pick<EvaluationSettings, "safeExamBrowser" | "kiosk">;

/**
 * The four ways the two trusted-client switches of an exam combine
 * (ADR-051 §2), in the order shown: both on means either client is accepted.
 * The icons are decorative and the same weight for every level: the OR of
 * `either` means the weaker path decides, so it shares SEB's half shield. No
 * colour per level.
 */
const CHOICES = [
  { id: "any", icon: Shield, settings: { safeExamBrowser: false, kiosk: false } },
  { id: "seb", icon: ShieldHalf, settings: { safeExamBrowser: true, kiosk: false } },
  { id: "either", icon: ShieldHalf, settings: { safeExamBrowser: true, kiosk: true } },
  { id: "kiosk", icon: ShieldCheck, settings: { safeExamBrowser: false, kiosk: true } },
] as const satisfies readonly { id: string; icon: LucideIcon; settings: Devices }[];

type Choice = (typeof CHOICES)[number];

const KEYS = ["safeExamBrowser", "kiosk"] as const satisfies readonly (keyof Devices)[];

/** The choice in force; the table covers every pair of the two booleans. */
const choiceOf = (settings: EvaluationSettings): Choice => {
  const now: Devices = { safeExamBrowser: safeExamBrowserOf(settings), kiosk: kioskOf(settings) };
  return CHOICES.find((c) => KEYS.every((k) => c.settings[k] === now[k]))!;
};

/**
 * "Allowed devices" of an exam: one choice over `safeExamBrowser` and `kiosk`,
 * written as the keys that change, in one patch. Where the platform has no
 * kiosk path the server refuses `kiosk: true` (`kiosk_unavailable`), so the
 * kiosk choices are offered only there — except the one in force, kept in
 * sight so it can be left.
 */
export function AllowedDevices({
  settings,
  kioskOffered,
  disabled,
  onChange,
}: {
  settings: EvaluationSettings;
  kioskOffered: boolean;
  disabled: boolean;
  onChange: (next: Partial<EvaluationSettings>) => void;
}) {
  const t = useT();
  const name = useId();
  const current = choiceOf(settings);
  const choices = CHOICES.filter((c) => kioskOffered || !c.settings.kiosk || c === current);

  const pick = (next: Choice["id"]) => {
    const to = CHOICES.find((c) => c.id === next)!.settings;
    const changed: Partial<Devices> = Object.fromEntries(
      KEYS.filter((k) => to[k] !== current.settings[k]).map((k) => [k, to[k]]),
    );
    if (Object.keys(changed).length > 0) onChange(changed);
  };

  return (
    <fieldset disabled={disabled} className="space-y-2 py-3">
      <legend className="sr-only">{t("eval.devices")}</legend>
      <p aria-hidden className="text-sm font-medium text-fg">{t("eval.devices")}</p>
      <div className="divide-y divide-line overflow-hidden rounded-field border border-line">
        {choices.map(({ id, icon: Icon }) => (
          <RadioRow key={id} name={name} value={id} checked={id === current.id} disabled={disabled} onPick={pick}>
            <span className="flex items-start gap-2.5">
              <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0">
                <span className="block font-medium text-fg">{t(`eval.devices.${id}`)}</span>
                <span className="mt-0.5 block text-[13px] text-fg-muted">{t(`eval.devices.${id}.desc`)}</span>
              </span>
            </span>
          </RadioRow>
        ))}
      </div>
    </fieldset>
  );
}
