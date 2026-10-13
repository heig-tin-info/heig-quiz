/*
 * The display switches of the live dashboard (F-DASH-02), remembered (#80).
 *
 * They are the TEACHER'S habit, not a property of the evaluation: somebody
 * who projects with the names hidden does so on every quiz, and finding the
 * names back on after a reload — in front of the class — is exactly the
 * moment the switch exists to prevent. So one key per browser, never one per
 * evaluation, and never on the server.
 *
 * Except during an exam (#796): there, Answers and Results start OFF on every
 * new exam, whatever the browser remembers, and turning one on lasts for that
 * exam in that tab only (`sessionStorage`, one key per evaluation) — a reload
 * keeps the teacher's deliberate choice, the next exam does not inherit it.
 * Answers and results switched on for an exercise in front of the class are
 * fine; carried into an exam on the projector, they are a leak. Names stay
 * the browser's habit in every mode: hiding them is the safe side.
 *
 * Storage is a convenience, never a requirement: `readStored`/`writeStored`
 * already swallow a storage that refuses (a private window, blocked site
 * data), and whatever is read is validated field by field — a value that is
 * not a boolean falls back to that field's default instead of taking the
 * whole preference down with it.
 */
import type { EvaluationMode } from "@quiz/contracts";
import { useCallback, useState } from "react";

import { readStored, writeStored } from "../ui";

export interface LiveToggles {
  names: boolean;
  answers: boolean;
  results: boolean;
}

/**
 * `-v2` since the defaults went OFF (#227): the first key was written with
 * all three ON by every browser that ever flipped one switch, and a
 * preference nobody chose kept the names and answers on the projector.
 * The new key lets the defaults speak once; a choice made since is kept.
 */
export const LIVE_TOGGLES_KEY = "quiz-live-toggles-v2";

/**
 * All three OFF on a first visit (#227). The dashboard is a projected screen
 * more often than not, and the safe first frame in front of a class is the
 * one that shows nobody's name and nobody's answer. Results off also spares
 * the server the provisional grading pass on every refresh (ADR-020) until
 * somebody actually asks for the colours. A browser that already stored a
 * choice keeps it: the defaults only speak where nothing was stored.
 */
export const LIVE_TOGGLE_DEFAULTS: Readonly<LiveToggles> = Object.freeze({
  names: false,
  answers: false,
  results: false,
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

/** The key of one exam's Answers and Results, in `sessionStorage` (#796). */
export function examTogglesKey(evaluationId: string): string {
  return `quiz-live-toggles-exam:${evaluationId}`;
}

interface Stored {
  evaluationId: string;
  /** The browser's habit, every field. */
  browser: LiveToggles;
  /** This exam's Answers and Results, in this tab (`names` unused). */
  exam: LiveToggles;
}

function readAll(evaluationId: string): Stored {
  return {
    evaluationId,
    browser: parseLiveToggles(readStored(LIVE_TOGGLES_KEY)),
    exam: parseLiveToggles(readStored(examTogglesKey(evaluationId), "session")),
  };
}

/**
 * Only an exercise takes Answers and Results from the browser's habit; an
 * exam does not, and neither does a mode not loaded yet — the safe frame
 * comes first, the colours a request later.
 */
function shown(stored: Stored, mode: EvaluationMode | undefined): LiveToggles {
  if (mode === "exercise") return stored.browser;
  return { names: stored.browser.names, answers: stored.exam.answers, results: stored.exam.results };
}

/**
 * The toggles of one evaluation's dashboard, read once from storage and
 * written back on every change. The setter takes an updater, like
 * `setState`, because the keyboard shortcuts flip a field from the previous
 * value.
 */
export function useLiveToggles(
  evaluationId: string,
  mode: EvaluationMode | undefined,
): [LiveToggles, (update: (prev: LiveToggles) => LiveToggles) => void] {
  const [stored, setStored] = useState<Stored>(() => readAll(evaluationId));
  // Another evaluation in the same mounted dashboard reads its own keys.
  const current = stored.evaluationId === evaluationId ? stored : readAll(evaluationId);
  if (current !== stored) setStored(current);
  const exam = mode !== "exercise";
  const update = useCallback(
    (fn: (prev: LiveToggles) => LiveToggles) => {
      setStored((prev) => {
        const next = fn(shown(prev, exam ? "exam" : "exercise"));
        // An exam never writes Answers and Results into the browser's habit.
        const browser = exam ? { ...prev.browser, names: next.names } : next;
        // Inside the updater so the value written is the one rendered, even
        // when two shortcuts land in the same tick. Writing is idempotent, so
        // StrictMode's double call costs nothing.
        writeStored(LIVE_TOGGLES_KEY, JSON.stringify(browser));
        if (exam) {
          const sitting = { answers: next.answers, results: next.results };
          writeStored(examTogglesKey(prev.evaluationId), JSON.stringify(sitting), "session");
        }
        return { ...prev, browser, exam: exam ? next : prev.exam };
      });
    },
    [exam],
  );
  return [shown(current, mode), update];
}
