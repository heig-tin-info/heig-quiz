import { useEffect, useSyncExternalStore } from "react";

import { readStored, removeStored, writeStored } from "./ui/state";

/**
 * Light/dark theme. "system" follows the OS and reacts to its changes; an
 * explicit choice is persisted in this browser.
 *
 * The choice is module state behind a tiny subscribable store, not component
 * state: two surfaces show it (the account menu toggle and the Settings
 * segmented control), and a `useState` in each meant the one you did not
 * touch kept showing the old value and its toggle became a no-op.
 */

export type ThemeChoice = "light" | "dark" | "system";
export type Theme = "light" | "dark";

const KEY = "quiz-theme";
/** Key of an earlier release; cleaned up on the first applyTheme of a session. */
const LEGACY_KEY = "quiz-ui-theme";
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

function initialTheme(): ThemeChoice {
  const stored = readStored(KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

/** The theme actually on screen for a choice. */
function resolveTheme(choice: ThemeChoice): Theme {
  return choice === "system" ? (media().matches ? "dark" : "light") : choice;
}

const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The choice in force. Storage is the state, not a module variable: the
 * snapshot is then a plain string, it survives a reload, and nothing can go
 * stale behind a test that clears localStorage.
 */
export function getThemeChoice(): ThemeChoice {
  return initialTheme();
}

/** Applies a choice, persists it and wakes every surface that shows it. */
export function setThemeChoice(next: ThemeChoice) {
  applyTheme(next);
  emit();
}

/** The stored choice (light / dark / system), for the Settings control. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, getThemeChoice, getThemeChoice);
}

/**
 * The theme actually on screen, for the surfaces that offer a light/dark
 * toggle. It follows an OS change too, because the "system" listener below
 * emits: the choice is still "system" but the resolved value flipped.
 */
export function useResolvedTheme(): Theme {
  const snapshot = () => resolveTheme(getThemeChoice());
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

let unsubscribe: (() => void) | null = null;

export function applyTheme(choice: ThemeChoice) {
  removeStored(LEGACY_KEY);
  const set = (theme: Theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  };
  set(resolveTheme(choice));
  if (choice === "system") removeStored(KEY);
  else writeStored(KEY, choice);
  unsubscribe?.();
  unsubscribe = null;
  if (choice === "system") {
    const m = media();
    const onChange = () => {
      set(m.matches ? "dark" : "light");
      emit();
    };
    m.addEventListener("change", onChange);
    unsubscribe = () => m.removeEventListener("change", onChange);
  }
}

/**
 * Dark unless this browser explicitly asked for light. It toggles the class
 * directly rather than going through `applyTheme`, so leaving the projection
 * gives the rest of the app its own theme back without ever having persisted
 * the beamer's; the toggle button below is what persists a real choice.
 */
export function useProjectionTheme(): { dark: boolean; toggle: () => void } {
  const choice = useThemeChoice();
  const dark = choice !== "light";
  useEffect(() => {
    const root = document.documentElement;
    const before = root.classList.contains("dark");
    const scheme = root.style.colorScheme;
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
    return () => {
      root.classList.toggle("dark", before);
      root.style.colorScheme = scheme;
    };
  }, [dark]);
  return { dark, toggle: () => setThemeChoice(dark ? "light" : "dark") };
}
