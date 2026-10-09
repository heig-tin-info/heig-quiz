import { kioskOf, safeExamBrowserOf, type EvaluationSettings } from "@quiz/contracts";
import { Shield, ShieldCheck, ShieldHalf, type LucideIcon } from "lucide-react";
import { useId } from "react";

import { useT } from "../i18n";
import { RadioRow } from "../ui";

/**
 * The four ways the two trusted-client switches of an exam combine
 * (ADR-051 §2): both on means either client is accepted.
 */
type Devices = "any" | "seb" | "either" | "kiosk";

const SETTINGS: Record<Devices, Pick<EvaluationSettings, "safeExamBrowser" | "kiosk">> = {
  any: { safeExamBrowser: false, kiosk: false },
  seb: { safeExamBrowser: true, kiosk: false },
  either: { safeExamBrowser: true, kiosk: true },
  kiosk: { safeExamBrowser: false, kiosk: true },
};

/**
 * Decorative, and the same weight for every level: the OR of `either` means
 * the weaker path decides, so it shares SEB's half shield. No colour per level.
 */
const ICON: Record<Devices, LucideIcon> = { any: Shield, seb: ShieldHalf, either: ShieldHalf, kiosk: ShieldCheck };

const ORDER: readonly Devices[] = ["any", "seb", "either", "kiosk"];

const devicesOf = (settings: EvaluationSettings): Devices => {
  const seb = safeExamBrowserOf(settings);
  const kiosk = kioskOf(settings);
  return seb ? (kiosk ? "either" : "seb") : kiosk ? "kiosk" : "any";
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
  const current = devicesOf(settings);
  const choices = ORDER.filter((d) => kioskOffered || !SETTINGS[d].kiosk || d === current);

  const pick = (next: Devices) => {
    const from = SETTINGS[current];
    const to = SETTINGS[next];
    const changed: Partial<EvaluationSettings> = {};
    if (from.safeExamBrowser !== to.safeExamBrowser) changed.safeExamBrowser = to.safeExamBrowser;
    if (from.kiosk !== to.kiosk) changed.kiosk = to.kiosk;
    if (Object.keys(changed).length > 0) onChange(changed);
  };

  return (
    <fieldset disabled={disabled} className="py-3">
      <legend className="float-left mb-2 w-full text-sm font-medium text-fg">{t("eval.devices")}</legend>
      <div className="clear-left divide-y divide-line overflow-hidden rounded-field border border-line">
        {choices.map((d) => {
          const Icon = ICON[d];
          return (
            <RadioRow key={d} name={name} value={d} checked={d === current} disabled={disabled} onPick={pick}>
              <span className="flex items-start gap-2.5">
                <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0">
                  <span className="block font-medium text-fg">{t(`eval.devices.${d}`)}</span>
                  <span className="mt-0.5 block text-[13px] text-fg-muted">{t(`eval.devices.${d}.desc`)}</span>
                </span>
              </span>
            </RadioRow>
          );
        })}
      </div>
    </fieldset>
  );
}
