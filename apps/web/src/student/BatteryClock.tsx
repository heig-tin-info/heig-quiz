/**
 * The machine's battery and the time, in the player's bar, for an attempt
 * sat in a confined session (issue #1151). Safe Exam Browser hides the
 * operating system's task bar (the `.seb` sets `showTaskBar: false`), and a
 * kiosk station shows none: there, the student has no other way to see that
 * the laptop is running out, nor what time it is.
 *
 * - Shown only where the Battery Status API answers (Chromium: SEB on
 *   Windows, a ChromeOS station). Absent or refused, nothing at all: SEB on
 *   macOS and iPad (WebKit) has no such API.
 * - Collapsed, the battery's icon and level; a click (or Enter, Space)
 *   unfolds the local time and the charge or the time left on the battery.
 *   A machine with no battery reports one full and charging forever: it shows
 *   a watch icon only (the countdown wears the clock), and unfolds the time.
 * - Quiet: the bar's 13 px, `fg-muted`, a hairline pill. It turns `warning`
 *   at 20 % and `danger` at 10 %, while discharging only; no dialog, no
 *   sound. The accent stays Hand in's, the countdown stays the clock that
 *   matters.
 * - The time is the browser's, for reading only: it closes nothing and
 *   counts nothing (invariant 5, the server owns the clock).
 */
import { BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning, Watch } from "lucide-react";
import { useState } from "react";

import { inputSize } from "@quiz/ui";

import { useI18n, useT, type TFunction } from "../i18n";
import { cx, MINUTE, percent, SECOND, timeLeft, timeOfDay, useBattery, useNow, type BatteryReading } from "../ui";

/** At or under this level, discharging, the pill turns `warning`. */
const LOW = 0.2;
/** At or under this one, `danger`. */
const CRITICAL = 0.1;

/**
 * What Chromium reports for a machine on mains with no battery — and for a
 * full one on its charger: full, charging, full now, never empty. Neither has
 * a level worth showing.
 */
const noBattery = (b: BatteryReading) =>
  b.level === 1 && b.charging && b.chargingTime === 0 && b.dischargingTime === Infinity;

type Tone = "warning" | "danger" | null;

/** The tone of a battery: only while it drains. */
function batteryTone(b: BatteryReading): Tone {
  if (b.charging) return null;
  return b.level <= CRITICAL ? "danger" : b.level <= LOW ? "warning" : null;
}

const TONE: Record<"neutral" | "warning" | "danger", string> = {
  neutral: "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg",
  warning: "border-transparent bg-warning-soft text-warning",
  danger: "border-transparent bg-danger-soft text-danger",
};

function icon(b: BatteryReading) {
  if (b.charging) return BatteryCharging;
  if (b.level <= CRITICAL) return BatteryWarning;
  if (b.level <= LOW) return BatteryLow;
  return b.level < 0.8 ? BatteryMedium : BatteryFull;
}

/** "charging", or the time left on the battery in whole minutes; nothing while the browser does not know it yet. */
function batteryState(b: BatteryReading, t: TFunction): string | null {
  if (b.charging) return t("player.battery.charging");
  if (!Number.isFinite(b.dischargingTime) || b.dischargingTime <= 0) return null;
  // `timeLeft` writes a span to a moment; this one starts at the epoch.
  const ms = Math.max(MINUTE, Math.floor((b.dischargingTime * SECOND) / MINUTE) * MINUTE);
  return t("player.battery.left", { time: timeLeft(new Date(ms).toISOString(), 0, t) });
}

export function BatteryClock() {
  const battery = useBattery();
  return battery ? <Pill battery={battery} /> : null;
}

function Pill({ battery }: { battery: BatteryReading }) {
  const t = useT();
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  // The second tick only while the time is on screen: it reads "14:05"
  // within the second the minute turns, never a minute late.
  const now = useNow(open ? SECOND : MINUTE);
  const shown = !noBattery(battery);
  const Icon = shown ? icon(battery) : Watch;
  const level = percent(battery.level, locale);
  const state = shown ? batteryState(battery, t) : null;
  const time = timeOfDay(now);
  const label = shown
    ? [t("player.battery.level", { level }), state, open ? t("player.battery.time", { time }) : null]
        .filter(Boolean)
        .join(", ")
    : open
      ? t("player.battery.time", { time })
      : t("player.battery.clock");
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={label}
      onClick={() => setOpen((o) => !o)}
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-control border tabular-nums transition-colors duration-150",
        inputSize.sm,
        TONE[(shown && batteryTone(battery)) || "neutral"],
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {/* The phone's bar has room for one figure: unfolded, the time takes
          the level's place, and the state waits for a wider screen. The
          accessible name keeps all three. */}
      {shown ? <span className={cx(open && "max-sm:hidden")}>{level}</span> : null}
      {open ? (
        <>
          {shown ? (
            <span aria-hidden className="max-sm:hidden">
              ·
            </span>
          ) : null}
          <span>{time}</span>
          {state ? (
            <span className="inline-flex items-center gap-1.5 max-sm:hidden">
              <span aria-hidden>·</span>
              <span>{state}</span>
            </span>
          ) : null}
        </>
      ) : null}
    </button>
  );
}
