/*
 * The way a teacher likes to grade, remembered across visits (#110): the
 * order of the traversal, the three filters, and the parts of an answer
 * shown (#109).
 *
 * It is the TEACHER'S habit, not a property of an evaluation — somebody who
 * grades by student with the prompts put away does so on every quiz — so
 * one key per browser, never one per evaluation, and never on the server.
 * Where they were in a given evaluation (the step, the open answer) is not
 * remembered: a new visit starts at the first step.
 *
 * "Show names" is deliberately NOT part of it (F-GRADE-03, decision D20):
 * grading is pseudonymous so that it stays impartial, and a switch that came
 * back on by itself would show real names on every visit without the
 * teacher choosing it that time. It is off each time the page opens.
 *
 * Storage is a convenience, never a requirement: `readStored`/`writeStored`
 * swallow a storage that refuses, and whatever is read is validated field by
 * field — a malformed field falls back to its own default instead of taking
 * the whole preference down with it.
 */
import { useCallback, useState } from "react";

import type { GradingConfidence, GradingSource } from "@quiz/contracts";

import { readStored, writeStored } from "../ui";
import type { GradingOrder } from "./labels";
import { ALL_PARTS_SHOWN, ANSWER_PARTS, type ShownParts } from "./parts";
import { ANY, type Any, type StateFilter } from "./useGradingTraversal";

export interface GradingView {
  order: GradingOrder;
  stateFilter: StateFilter;
  source: GradingSource | Any;
  confidence: GradingConfidence | Any;
  parts: ShownParts;
}

export const GRADING_VIEW_KEY = "quiz-grading-view";

export const GRADING_VIEW_DEFAULTS: Readonly<GradingView> = Object.freeze({
  order: "question",
  stateFilter: "all",
  source: ANY,
  confidence: ANY,
  parts: ALL_PARTS_SHOWN,
});

const ORDERS: readonly GradingOrder[] = ["question", "student"];
const STATES: readonly StateFilter[] = ["all", "proposed", "validated"];
const SOURCES: readonly (GradingSource | Any)[] = [ANY, "auto", "llm", "manual"];
const CONFIDENCES: readonly (GradingConfidence | Any)[] = [ANY, "low", "medium", "high"];

function oneOf<T extends string>(values: readonly T[], raw: unknown, fallback: T): T {
  return typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stored string as a view: the defaults for anything missing or malformed. */
export function parseGradingView(raw: string | null): GradingView {
  const d = GRADING_VIEW_DEFAULTS;
  let parsed: unknown = null;
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const r = isRecord(parsed) ? parsed : {};
  const storedParts = isRecord(r.parts) ? r.parts : {};
  const parts = { ...d.parts };
  for (const part of ANSWER_PARTS) {
    const value = storedParts[part];
    if (typeof value === "boolean") parts[part] = value;
  }
  return {
    order: oneOf(ORDERS, r.order, d.order),
    stateFilter: oneOf(STATES, r.stateFilter, d.stateFilter),
    source: oneOf(SOURCES, r.source, d.source),
    confidence: oneOf(CONFIDENCES, r.confidence, d.confidence),
    parts,
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
