import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { api } from "../api";
import { readStored, writeStored } from "../ui/state";
import { type Dict, en } from "./en";
import { fr } from "./fr";

/**
 * Lightweight i18n: a flat key -> string dictionary per locale, a `t(key,
 * vars)` helper with `{var}` interpolation, and a provider that persists the
 * chosen language to the user's account (so it follows them across devices)
 * with a localStorage mirror for an instant, flash-free first paint. English
 * is the fallback for any missing key or unset locale.
 *
 * Scope: EVERY user-facing surface goes through `t()`, teacher screens
 * included (N-I18N-01) — a teacher in Yverdon reads French. The dictionary is
 * flat and typed: `fr` is `Record<keyof Dict, string>`, so a key added in
 * English without its French twin is a compile error. Keep it that way.
 *
 * The two dictionaries live next door, in `en.ts` and `fr.ts`: this file is
 * the machinery that reads them.
 */
export type Locale = "en" | "fr";

export const LOCALES: { code: Locale; label: string }[] = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
];

const STORE_KEY = "quiz-locale";

export type { Dict };

export const DICTS: Record<Locale, Record<string, string>> = { en, fr };

export type TFunction = (key: keyof Dict, vars?: Record<string, string | number>) => string;

function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[locale]?.[key] ?? DICTS.en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) =>
    Object.hasOwn(vars, k) ? String(vars[k]) : `{${k}}`,
  );
}

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale, persist?: boolean) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nValue>({
  locale: "en",
  setLocale: () => {},
  t: (k) => translate("en", k),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored = readStored(STORE_KEY);
    return stored === "fr" || stored === "en" ? stored : "en";
  });
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((l: Locale, persist = true) => {
    setLocaleState(l);
    writeStored(STORE_KEY, l);
    if (persist) {
      void api("/app/api/me", { method: "PATCH", body: JSON.stringify({ locale: l }) }).catch(
        () => {},
      );
    }
  }, []);
  const t = useCallback<TFunction>((key, vars) => translate(locale, key, vars), [locale]);
  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function useT(): TFunction {
  return useContext(I18nContext).t;
}

/** "4 days, 2 hours and 23 minutes" — localized, largest three units. */
export function formatDuration(ms: number, t: TFunction): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(t(days === 1 ? "dur.day" : "dur.days", { n: days }));
  if (hours > 0) parts.push(t(hours === 1 ? "dur.hour" : "dur.hours", { n: hours }));
  if (minutes > 0 || parts.length === 0) {
    if (minutes === 0 && parts.length === 0) return t("dur.soon");
    parts.push(t(minutes === 1 ? "dur.minute" : "dur.minutes", { n: minutes }));
  }
  if (parts.length === 1) return parts[0]!;
  const last = parts.pop()!;
  return `${parts.join(", ")} ${t("dur.and")} ${last}`;
}
