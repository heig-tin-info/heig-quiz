import { kioskOf, safeExamBrowserOf, type EvaluationSettings } from "@quiz/contracts";
import {
  DEVICE_LEVELS,
  TRUSTED_CLIENTS,
  TRUSTED_CLIENT_SWITCH,
  acceptsKiosk,
  deviceLevelClients,
  deviceLevelOf,
  type DeviceLevel,
} from "@quiz/domain";
import { Shield, ShieldCheck, ShieldHalf, type LucideIcon } from "lucide-react";
import { useId } from "react";

import { useT, type Dict } from "../i18n";
import { RadioRow } from "../ui";

type Devices = Pick<EvaluationSettings, "safeExamBrowser" | "kiosk">;

/**
 * The icon of each device level (`DEVICE_LEVELS` of `@quiz/domain`, ADR-089
 * point 2, in the order shown). The icons are decorative and the same weight
 * for every level: the OR of `either` means the weaker path decides, so it
 * shares SEB's half shield. No colour per level.
 */
const ICONS: Record<DeviceLevel, LucideIcon> = { any: Shield, seb: ShieldHalf, either: ShieldHalf, kiosk: ShieldCheck };

const KEYS = TRUSTED_CLIENTS.map((c) => TRUSTED_CLIENT_SWITCH[c]);

/** An exam's two trusted-client switches (ADR-051 §2) at a level: both on means either client is accepted. */
const devicesOf = (level: DeviceLevel): Devices =>
  Object.fromEntries(TRUSTED_CLIENTS.map((c) => [TRUSTED_CLIENT_SWITCH[c], deviceLevelClients(level).includes(c)])) as Devices;

/** An exam's level in force; the table covers every pair of the two booleans. */
const levelOf = (settings: EvaluationSettings): DeviceLevel => {
  const now: Devices = { safeExamBrowser: safeExamBrowserOf(settings), kiosk: kioskOf(settings) };
  return deviceLevelOf(TRUSTED_CLIENTS.filter((c) => now[TRUSTED_CLIENT_SWITCH[c]]));
};

/** The sub-text of each level: an exam's by default; a project words its own where the exam's says "exam". */
const EXAM_DESC = (level: DeviceLevel): keyof Dict => `eval.devices.${level}.desc`;

/**
 * "Allowed devices" (ADR-089, amendment point 2, "One control"): one choice
 * among the device levels, for an exam and for a supervised project alike.
 * Where the platform has no kiosk path for the activity the server refuses a
 * change to a station level (`kiosk_unavailable`), so those choices are
 * offered only there — except the one in force, kept in sight so it can be
 * left. Picking the level in force sends nothing.
 */
export function AllowedDevices({
  level,
  kioskOffered,
  disabled,
  onPick,
  descOf = EXAM_DESC,
}: {
  level: DeviceLevel;
  kioskOffered: boolean;
  disabled: boolean;
  onPick: (next: DeviceLevel) => void;
  descOf?: (level: DeviceLevel) => keyof Dict;
}) {
  const t = useT();
  const name = useId();
  const choices = DEVICE_LEVELS.filter((l) => kioskOffered || !acceptsKiosk(l.id) || l.id === level).map((l) => ({
    id: l.id,
    icon: ICONS[l.id],
  }));
  const pick = (next: DeviceLevel) => {
    if (next !== level) onPick(next);
  };

  return (
    <fieldset disabled={disabled} className="space-y-2 py-3">
      <legend className="sr-only">{t("eval.devices")}</legend>
      <p aria-hidden className="text-sm font-medium text-fg">{t("eval.devices")}</p>
      <div className="divide-y divide-line overflow-hidden rounded-field border border-line">
        {choices.map(({ id, icon: Icon }) => (
          <RadioRow key={id} name={name} value={id} checked={id === level} disabled={disabled} onPick={pick}>
            <span className="flex items-start gap-2.5">
              <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0">
                <span className="block font-medium text-fg">{t(`eval.devices.${id}`)}</span>
                <span className="mt-0.5 block text-[13px] text-fg-muted">{t(descOf(id))}</span>
              </span>
            </span>
          </RadioRow>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * An exam's "Allowed devices": the level its two switches (`safeExamBrowser`,
 * `kiosk`) stand for, written back as the keys that change, in one patch.
 */
export function EvaluationDevices({
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
  const current = levelOf(settings);
  const pick = (next: DeviceLevel) => {
    const [from, to] = [devicesOf(current), devicesOf(next)];
    onChange(Object.fromEntries(KEYS.filter((k) => to[k] !== from[k]).map((k) => [k, to[k]])));
  };
  return <AllowedDevices level={current} kioskOffered={kioskOffered} disabled={disabled} onPick={pick} />;
}
