import { useCallback, useEffect, useState } from "react";

// --- Module state that several surfaces read ---

/**
 * The change signal of a module store read through `useSyncExternalStore`
 * (the theme, the student view, the shortcuts, the connection): its readers
 * `subscribe`, and a write calls `emit` once the new state is in place.
 */
export function createSignal(): { subscribe: (listener: () => void) => () => void; emit: () => void } {
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: () => {
      for (const listener of listeners) listener();
    },
  };
}

// --- Remembered choices (a viewer's habit, never a state of the data) ---

/**
 * Where a value is kept: `local` for the browser (a habit), `session` for
 * this tab alone (the student view, ADR-018).
 */
type Area = "local" | "session";

/**
 * What a refused `sessionStorage` would hold, for the life of the page: the
 * student view must still enter and leave in a window that blocks storage
 * (it only no longer survives a reload). A refused `localStorage` keeps
 * nothing: a habit costs one click.
 */
const refusedSession = new Map<string, string>();

/**
 * Reading storage may throw — a private window, blocked site data, even the
 * mere access to `sessionStorage` — and that is never worth a crash: `null`
 * is "nothing stored".
 */
export function readStored(key: string, area: Area = "local"): string | null {
  try {
    return (area === "local" ? localStorage : sessionStorage).getItem(key);
  } catch {
    return area === "session" ? (refusedSession.get(key) ?? null) : null;
  }
}

/** Writing may throw for the same reasons, and a quota. */
export function writeStored(key: string, value: string, area: Area = "local"): void {
  try {
    (area === "local" ? localStorage : sessionStorage).setItem(key, value);
  } catch {
    if (area === "session") refusedSession.set(key, value);
  }
}

/** Removing may throw like the other two; a stale key is harmless. */
export function removeStored(key: string, area: Area = "local"): void {
  try {
    (area === "local" ? localStorage : sessionStorage).removeItem(key);
  } catch {
    if (area === "session") refusedSession.delete(key);
  }
}

/**
 * A choice the reader makes once and expects to find again — table or cards,
 * the grouping of a list, the classroom of the last poll — remembered per
 * browser in `localStorage` under `key`.
 *
 * `values` says what a stored string may be: the closed list of choices, or a
 * predicate when the set is open (an id). Anything else, nothing stored, or a
 * storage that refuses to be read gives `fallback`. The setter writes then
 * updates, and a storage that refuses the write still updates the screen.
 */
export function usePersistentChoice<T extends string>(
  key: string,
  values: readonly T[] | ((raw: string) => raw is T),
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = readStored(key);
    if (raw === null) return fallback;
    const accepted =
      typeof values === "function" ? values(raw) : (values as readonly string[]).includes(raw);
    return accepted ? (raw as T) : fallback;
  });
  const set = useCallback(
    (next: T) => {
      writeStored(key, next);
      setValue(next);
    },
    [key],
  );
  return [value, set];
}

// --- The keyboard and the screen ---

/**
 * A keystroke typed into a field is not a shortcut: `f`, `r`, `v` or an arrow
 * pressed in an input, a textarea, a select or a contenteditable surface (the
 * rich editor) belongs to that field.
 */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return (
    tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable === true
  );
}

/**
 * The in-page and the browser full screen, together (a projector wants both).
 *
 * `on` drives the page-level mode — a `fixed inset-0` stage, which is all a
 * projector really needs. The browser's own `requestFullscreen` is attempted
 * on top, and a refusal (a permissions policy, a headless run) is swallowed
 * on purpose: the page-level mode is enough. Escape, F11 and the browser's
 * own chrome all leave full screen without going through `toggle`, so the
 * `fullscreenchange` event is the only truth about it and `on` follows it.
 */
export function useFullscreen(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  // The browser call lives in the toggle and not in a `setOn` updater: an
  // updater must be pure, and StrictMode runs it twice.
  const toggle = useCallback(() => {
    const ignore = () => {};
    try {
      if (!on) document.documentElement.requestFullscreen?.().catch(ignore);
      else if (document.fullscreenElement) document.exitFullscreen?.().catch(ignore);
    } catch {
      /* the in-page mode is enough */
    }
    setOn(!on);
  }, [on]);
  useEffect(() => {
    const sync = () => setOn(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  return [on, toggle];
}

// --- The device ---

/** What the Battery Status API says of the machine, at its last event. */
export type BatteryReading = {
  /** 0 to 1. */
  level: number;
  charging: boolean;
  /** Seconds to full; `Infinity` when unknown or discharging. */
  chargingTime: number;
  /** Seconds to empty; `Infinity` when unknown or charging. */
  dischargingTime: number;
};

/** The `BatteryManager` of the Battery Status API, which the DOM typings leave out. */
type BatteryManager = BatteryReading & EventTarget;

const BATTERY_EVENTS = ["levelchange", "chargingchange", "chargingtimechange", "dischargingtimechange"];

/**
 * The machine's battery, followed through its events (issue #1151), or
 * `null` while it is asked for and wherever it cannot be read: a browser
 * without `navigator.getBattery` (Safari, so Safe Exam Browser on macOS and
 * iPad; Firefox) or one that refuses it. Never a guess: a screen shows
 * nothing rather than a level it made up.
 */
export function useBattery(): BatteryReading | null {
  const [reading, setReading] = useState<BatteryReading | null>(null);
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };
    if (typeof nav.getBattery !== "function") return;
    let battery: BatteryManager | null = null;
    let gone = false;
    const read = () => {
      if (!battery) return;
      const { level, charging, chargingTime, dischargingTime } = battery;
      setReading({ level, charging, chargingTime, dischargingTime });
    };
    nav
      .getBattery()
      .then((b) => {
        if (gone) return;
        battery = b;
        for (const name of BATTERY_EVENTS) b.addEventListener(name, read);
        read();
      })
      .catch(() => {
        /* refused: nothing to show */
      });
    return () => {
      gone = true;
      if (battery) for (const name of BATTERY_EVENTS) battery.removeEventListener(name, read);
    };
  }, []);
  return reading;
}
