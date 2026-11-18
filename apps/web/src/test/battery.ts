import { act } from "@testing-library/react";

import type { BatteryReading } from "../ui/state";

/**
 * A `BatteryManager` for jsdom, which has no Battery Status API: installed on
 * `navigator.getBattery`, changed by `set`, which fires the API's event for
 * what changed (issue #1151). `uninstallBattery` takes it away again.
 */
export function installBattery(initial: Partial<BatteryReading> = {}) {
  const target = new EventTarget();
  const state: BatteryReading = { level: 0.5, charging: false, chargingTime: Infinity, dischargingTime: 3600, ...initial };
  const battery = Object.assign(target, state);
  Object.defineProperty(navigator, "getBattery", { configurable: true, value: () => Promise.resolve(battery) });
  return {
    battery,
    /** Changes the reading and fires `levelchange`, as a real drain does. */
    set: (next: Partial<BatteryReading>) =>
      act(() => {
        Object.assign(battery, next);
        target.dispatchEvent(new Event("charging" in next ? "chargingchange" : "levelchange"));
      }),
  };
}

/** A browser whose `getBattery` refuses (a permissions policy). */
export function refuseBattery() {
  Object.defineProperty(navigator, "getBattery", {
    configurable: true,
    value: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
  });
}

/** Back to jsdom's own navigator, without the API. */
export function uninstallBattery() {
  delete (navigator as { getBattery?: unknown }).getBattery;
}
