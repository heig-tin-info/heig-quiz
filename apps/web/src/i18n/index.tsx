import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { api } from "../api";
import { readStored, writeStored } from "../ui/state";
import { setTranslator } from "./current";
import { type Dict, en } from "./en";

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
 * the machinery that reads them. English is in the entry chunk, as the
 * fallback it is; French is a chunk of its own, loaded by `loadLocale` before
 * it is shown — before the first render when it is the stored choice
 * (`main.tsx`), before the switch when it is picked — so no screen paints in
 * English and then flips. `fr.ts` keeps its `Record<keyof Dict, string>`
 * type: the dynamic import changes when it loads, not what it must contain.
 *
 * What the user picks is a `LocaleChoice`: a language, or "browser" — the
 * default, `locale = null` on the account — which follows `navigator.languages`.
 * A French Chrome therefore gets the French UI rather than an English page it
 * offers to machine-translate: Chrome's translation rewrites React's text
 * nodes and crashes the next render (#228), and an exam statement must read
 * as the teacher wrote it. `index.html` also forbids that translation outright.
 */
export type Locale = "en" | "fr";
export type LocaleChoice = Locale | "browser";

export const LOCALES: { code: Locale; label: string }[] = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
];

const STORE_KEY = "quiz-locale";

export type { Dict };

/** The loaded dictionaries: English always, French once `loadLocale` resolved. */
export const DICTS: { en: Record<string, string> } & Partial<Record<Locale, Record<string, string>>> =
  { en };

const loaders: Record<Exclude<Locale, "en">, () => Promise<Record<string, string>>> = {
  fr: () => import("./fr").then((m) => m.fr),
};

/** Resolves once `locale`'s dictionary is in `DICTS`; at once for English. */
export async function loadLocale(locale: Locale): Promise<void> {
  if (DICTS[locale]) return;
  if (locale === "en") return;
  DICTS[locale] = await loaders[locale]();
}

/** The first of the browser's preferred languages the app speaks, English when none. */
export function browserLocale(): Locale {
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of preferred) {
    const base = tag?.toLowerCase().split("-")[0];
    if (base === "fr" || base === "en") return base;
  }
  return "en";
}

export function resolveLocale(choice: LocaleChoice): Locale {
  return choice === "browser" ? browserLocale() : choice;
}

/** What this browser last chose, "browser" when nothing. */
export function storedChoice(): LocaleChoice {
  const raw = readStored(STORE_KEY);
  return raw === "fr" || raw === "en" ? raw : "browser";
}

/** The language to paint in: the stored choice, resolved. */
export function storedLocale(): Locale {
  return resolveLocale(storedChoice());
}

export type TFunction = (key: keyof Dict, vars?: Record<string, string | number>) => string;

function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[locale]?.[key] ?? DICTS.en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) =>
    Object.hasOwn(vars, k) ? String(vars[k]) : `{${k}}`,
  );
}

interface I18nValue {
  /** The language shown. */
  locale: Locale;
  /** What the user picked, "browser" included. */
  choice: LocaleChoice;
  setLocale: (choice: LocaleChoice, persist?: boolean) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nValue>({
  locale: "en",
  choice: "browser",
  setLocale: () => {},
  t: (k) => translate("en", k),
});

export function I18nProvider({ children }: { children: ReactNode }) {
  // The stored language when its dictionary is already here (`main.tsx`
  // waits for it); otherwise English until the effect below has loaded it.
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored = storedLocale();
    return DICTS[stored] ? stored : "en";
  });
  const [choice, setChoice] = useState<LocaleChoice>(storedChoice);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  // The last language asked for: a slower load of an earlier choice (French,
  // then English at once) must not land after it and win.
  const requested = useRef<Locale | null>(null);
  const switchTo = useCallback((l: Locale) => {
    requested.current = l;
    // Switched once the words are here: never a frame of the old language
    // under the new `lang`. A failed load keeps the current language.
    void loadLocale(l).then(
      () => {
        if (requested.current === l) setLocaleState(l);
      },
      () => {},
    );
  }, []);
  useEffect(() => {
    const stored = storedLocale();
    if (!DICTS[stored]) switchTo(stored);
  }, [switchTo]);
  const setLocale = useCallback((c: LocaleChoice, persist = true) => {
    switchTo(resolveLocale(c));
    setChoice(c);
    writeStored(STORE_KEY, c);
    if (persist) {
      const locale = c === "browser" ? null : c;
      void api("/app/api/me", { method: "PATCH", body: JSON.stringify({ locale }) }).catch(
        () => {},
      );
    }
  }, [switchTo]);
  const t = useCallback<TFunction>((key, vars) => translate(locale, key, vars), [locale]);
  // Idempotent, so safe in render: `apiErrorMessage` words the next refusal in this language.
  setTranslator(t);
  return <I18nContext.Provider value={{ locale, choice, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  return useContext(I18nContext);
}

export function useT(): TFunction {
  return useContext(I18nContext).t;
}

/**
 * "45 s", "2 min 05 s", "1 h 12 min": a span of seconds, compact, two units
 * at most, and never broken across two lines (the spaces are non-breaking).
 */
export function formatSpan(seconds: number, t: TFunction): string {
  const total = Math.max(0, Math.round(seconds));
  const text =
    total < 60
      ? t("dur.s", { n: total })
      : total < 3600
        ? t("dur.minSec", { m: Math.floor(total / 60), s: String(total % 60).padStart(2, "0") })
        : t("dur.hourMin", { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60) });
  return text.replace(/ /g, "\u00a0");
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
