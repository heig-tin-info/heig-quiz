/*
 * The way a teacher likes to grade, remembered across visits (#110): the
 * state filter, and who graded with what confidence.
 *
 * It is the TEACHER'S habit, not a property of an evaluation, so one key per
 * browser, never one per evaluation, and never on the server. Where they
 * were in a given evaluation (the question, the open answer, a sort) is not
 * remembered: a new visit starts at the first question.
 *
 * "Anonymise" is deliberately NOT part of it (F-GRADE-03, ADR-040): it is on
 * at every visit, and a switch that stayed off by itself would show names on
 * every visit without the teacher choosing it that time.
 *
 * Storage is a convenience, never a requirement: `readStored`/`writeStored`
 * swallow a storage that refuses, and whatever is read is validated field by
 * field — a malformed field falls back to its own default, and a field of an
 * older version of this view (`order`, `parts`) is simply dropped.
 */
import { useCallback, useState } from "react";

import type { GradingConfidence, GradingSource } from "@quiz/contracts";

import { readStored, writeStored } from "../ui";
import { ANY, type Any, type StateFilter } from "./rows";

export interface GradingView {
  stateFilter: StateFilter;
  source: GradingSource | Any;
  confidence: GradingConfidence | Any;
}

export const GRADING_VIEW_KEY = "quiz-grading-view";

export const GRADING_VIEW_DEFAULTS: Readonly<GradingView> = Object.freeze({
  stateFilter: "all",
  source: ANY,
  confidence: ANY,
});

const SOURCES: readonly (GradingSource | Any)[] = [ANY, "auto", "llm", "manual"];
const CONFIDENCES: readonly (GradingConfidence | Any)[] = [ANY, "low", "medium", "high"];

function oneOf<T extends string>(values: readonly T[], raw: unknown, fallback: T): T {
  return typeof raw === "string" && (values as readonly string[]).includes(raw)
    ? (raw as T)
    : fallback;
}

/**
 * The state filter as stored. `proposed` is what the previous panel stored
 * for "To validate", so a teacher who left it on keeps it; its third value,
 * `validated`, has no control any more and reads as "All".
 */
function stateFilterOf(raw: unknown): StateFilter {
  return raw === "todo" || raw === "proposed" ? "todo" : "all";
}

/** The stored string as a view: the defaults for anything missing or malformed. */
export function parseGradingView(raw: string | null): GradingView {
  let parsed: unknown = null;
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const r =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    stateFilter: stateFilterOf(r.stateFilter),
    source: oneOf(SOURCES, r.source, GRADING_VIEW_DEFAULTS.source),
    confidence: oneOf(CONFIDENCES, r.confidence, GRADING_VIEW_DEFAULTS.confidence),
  };
}

/**
 * The view, read once from storage and written back on every change. The
 * setter merges a patch, so each control changes its own field only.
 */
export function useGradingView(): [GradingView, (patch: Partial<GradingView>) => void] {
  const [view, setView] = useState<GradingView>(() =>
    parseGradingView(readStored(GRADING_VIEW_KEY)),
  );
  const update = useCallback((patch: Partial<GradingView>) => {
    setView((prev) => {
      const next = { ...prev, ...patch };
      // Inside the updater so what is written is what is rendered; writing
      // is idempotent, so StrictMode's double call costs nothing.
      writeStored(GRADING_VIEW_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return [view, update];
}
