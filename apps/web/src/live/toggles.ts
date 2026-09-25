/*
 * The display switches of the live dashboard (F-DASH-02), remembered (#80).
 *
 * They are the TEACHER'S habit, not a property of the evaluation: somebody
 * who projects with the names hidden does so on every quiz, and finding the
 * names back on after a reload — in front of the class — is exactly the
 * moment the switch exists to prevent. So one key per browser, never one per
 * evaluation, and never on the server.
 *
 * Storage is a convenience, never a requirement: `readStored`/`writeStored`
 * already swallow a storage that refuses (a private window, blocked site
 * data), and whatever is read is validated field by field — a value that is
 * not a boolean falls back to that field's default instead of taking the
 * whole preference down with it.
 */
import { useCallback, useState } from "react";

import { readStored, writeStored } from "../ui";

export interface LiveToggles {
  names: boolean;
  answers: boolean;
  results: boolean;
}

export const LIVE_TOGGLES_KEY = "quiz-live-toggles";

export const LIVE_TOGGLE_DEFAULTS: Readonly<LiveToggles> = Object.freeze({
  names: true,
  answers: true,
  results: true,
});

const FIELDS = ["names", "answers", "results"] as const;

/** The stored string as toggles: the defaults for anything missing or malformed. */
export function parseLiveToggles(raw: string | null): LiveToggles {
  const out: LiveToggles = { ...LIVE_TOGGLE_DEFAULTS };
  if (raw === null) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  const record = parsed as Record<string, unknown>;
  for (const field of FIELDS) {
    const value = record[field];
    if (typeof value === "boolean") out[field] = value;
  }
  return out;
}

/**
 * The toggles, read once from storage and written back on every change. The
 * setter takes an updater, like `setState`, because the keyboard shortcuts
 * flip a field from the previous value.
 */
export function useLiveToggles(): [LiveToggles, (update: (prev: LiveToggles) => LiveToggles) => void] {
  const [toggles, setToggles] = useState<LiveToggles>(() =>
    parseLiveToggles(readStored(LIVE_TOGGLES_KEY)),
  );
  const update = useCallback((fn: (prev: LiveToggles) => LiveToggles) => {
    setToggles((prev) => {
      const next = fn(prev);
      // Inside the updater so the value written is the one rendered, even
      // when two shortcuts land in the same tick. Writing is idempotent, so
      // StrictMode's double call costs nothing.
      writeStored(LIVE_TOGGLES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [toggles, update];
}
