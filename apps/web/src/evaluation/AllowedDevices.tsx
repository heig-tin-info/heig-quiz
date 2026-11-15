import { kioskOf, safeExamBrowserOf, type EvaluationSettings } from "@quiz/contracts";
import { DEVICE_LEVELS, acceptsKiosk, deviceLevelClients, deviceLevelOf, type DeviceLevel } from "@quiz/domain";
import { Shield, ShieldCheck, ShieldHalf, type LucideIcon } from "lucide-react";
import { useId } from "react";

import { useT } from "../i18n";
import { RadioRow } from "../ui";

type Devices = Pick<EvaluationSettings, "safeExamBrowser" | "kiosk">;

/**
 * The icon of each device level (`DEVICE_LEVELS` of `@quiz/domain`, ADR-089
 * point 2, in the order shown). The icons are decorative and the same weight
 * for every level: the OR of `either` means the weaker path decides, so it
 * shares SEB's half shield. No colour per level.
 */
const ICONS: Record<DeviceLevel, LucideIcon> = { any: Shield, seb: ShieldHalf, either: ShieldHalf, kiosk: ShieldCheck };

const KEYS = ["safeExamBrowser", "kiosk"] as const satisfies readonly (keyof Devices)[];

/** An exam's two trusted-client switches (ADR-051 §2) at a level: both on means either client is accepted. */
const devicesOf = (level: DeviceLevel): Devices => {
  const clients = deviceLevelClients(level);
  return { safeExamBrowser: clients.includes("seb"), kiosk: clients.includes("kiosk") };
};

/** The level in force; the table covers every pair of the two booleans. */
const levelOf = (settings: EvaluationSettings): DeviceLevel =>
  deviceLevelOf([...(safeExamBrowserOf(settings) ? (["seb"] as const) : []), ...(kioskOf(settings) ? (["kiosk"] as const) : [])]);

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
  const current = levelOf(settings);
  const choices = DEVICE_LEVELS.filter((l) => kioskOffered || !acceptsKiosk(l.id) || l.id === current).map((l) => ({
    id: l.id,
    icon: ICONS[l.id],
  }));

  const pick = (next: DeviceLevel) => {
    const [from, to] = [devicesOf(current), devicesOf(next)];
    const changed: Partial<Devices> = Object.fromEntries(KEYS.filter((k) => to[k] !== from[k]).map((k) => [k, to[k]]));
    if (Object.keys(changed).length > 0) onChange(changed);
  };

  return (
    <fieldset disabled={disabled} className="space-y-2 py-3">
      <legend className="sr-only">{t("eval.devices")}</legend>
      <p aria-hidden className="text-sm font-medium text-fg">{t("eval.devices")}</p>
      <div className="divide-y divide-line overflow-hidden rounded-field border border-line">
        {choices.map(({ id, icon: Icon }) => (
          <RadioRow key={id} name={name} value={id} checked={id === current} disabled={disabled} onPick={pick}>
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
