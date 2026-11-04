/**
 * The {@link PlayerSession} of a paper copy typed in by a staff member
 * (ADR-125 §9): the local session (`useLocalPlayerSession`), loaded ONCE
 * from the paper the server built (the hand-out's order), with what the
 * paper adds:
 *
 *   - the navigation is free whatever the exam's: the paper is typed in the
 *     order the teacher reads it;
 *   - a `sessionStorage` draft keyed on the evaluation and the student, so a
 *     reload of the tab keeps the answers; nothing is sent before "Hand in
 *     the copy";
 *   - no clock: the platform enforces no deadline on paper (invariant 5),
 *     the hand-in time is the server's;
 *   - nothing runs: no printable type has a Run or a Simulate.
 */
import { useEffect, useState } from "react";

import type { AttemptView, PaperItems } from "@quiz/contracts";

import { useLocalPlayerSession } from "../attempt/useLocalPlayerSession";
import type { PlayerSession } from "../student/Player";

/** The draft's key: one per evaluation and student, in this tab only. */
export const paperDraftKey = (evaluationId: string, userId: string) => `quiz.paper.${evaluationId}.${userId}`;

/** The draft of a previous load of this tab, or nothing. Storage may refuse: then there is none. */
function readDraft(key: string): Record<string, unknown> {
  try {
    const raw = window.sessionStorage.getItem(key);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeDraft(key: string, answers: Record<string, unknown>): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(answers));
  } catch {
    // A private window, a full storage: the answers stay in the page.
  }
}

/** Forgets the draft: the copy was handed in. */
export function clearPaperDraft(evaluationId: string, userId: string): void {
  try {
    window.sessionStorage.removeItem(paperDraftKey(evaluationId, userId));
  } catch {
    // Nothing stored, nothing to forget.
  }
}

/**
 * The paper's view as the player loads it: navigation free, and the draft's
 * answers in place — an item the server no longer holds is dropped.
 */
export function paperView(paper: PaperItems, draft: Readonly<Record<string, unknown>>): AttemptView {
  const { view } = paper;
  return {
    ...view,
    evaluation: { ...view.evaluation, settings: { ...view.evaluation.settings, navigation: "free" } },
    items: view.items.map((item) => (item.id in draft ? { ...item, answer: draft[item.id] } : item)),
  };
}

// No printable type runs anything (ADR-125 §5): the player says so in one line.
const run: PlayerSession["run"] = async () => "unavailable";
const simulate: PlayerSession["simulate"] = async () => "unavailable";

export function usePaperSession({
  evaluationId,
  userId,
  paper,
  onSubmit,
}: {
  evaluationId: string;
  userId: string;
  paper: PaperItems;
  /** Hands the copy in: the page posts it and says what came of it. */
  onSubmit: (answers: Record<string, unknown>) => Promise<void>;
}): PlayerSession {
  const key = paperDraftKey(evaluationId, userId);
  // ONCE per mount (the page keys it on the student): a refetch of the paper
  // (a reconnect re-reads every query) never reloads the player under the
  // answers being typed.
  const [view] = useState(() => paperView(paper, readDraft(key)));
  const session = useLocalPlayerSession({ view, deadlineAt: null, onSubmit, run, simulate });

  const { answers } = session.state;
  const loaded = session.state.items.length > 0;
  useEffect(() => {
    if (loaded) writeDraft(key, answers);
  }, [key, answers, loaded]);

  return session;
}
