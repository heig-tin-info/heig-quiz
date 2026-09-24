import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";

import type { DraftSaved, PoolDetail, QuestionDetail, ZodIssueLite } from "@quiz/contracts";

import { api } from "../api";
import { poolKey, questionKey } from "../queryKeys";
import { useAutosave } from "./autosave";

/** The working copy of a question: what the type's editor and the explanation edit. */
export interface Draft {
  config: unknown;
  explanation: string;
}

/**
 * The question editor's data: the question, its pool, and the DRAFT — the
 * local working copy, its autosave, the issues the last save came back with,
 * and whether the teacher has changed anything in this session.
 *
 * `setDraft` is the teacher's edit: it marks the session `edited`. The copy
 * that arrives from the server goes through the reconciliation below instead.
 */
export function useQuestionDraft(id: string) {
  const [draft, setLocalDraft] = useState<Draft | null>(null);
  const [issues, setIssues] = useState<readonly ZodIssueLite[]>([]);
  // Whether the teacher has changed anything in this session. A question is
  // created EMPTY now (the type's `emptyDraft()` carries no content), so its
  // stored draft is invalid from the first second and the warning below would
  // greet every new question with a complaint about work not yet started.
  const [edited, setEdited] = useState(false);

  const detail = useQuery<QuestionDetail>({
    queryKey: questionKey(id),
    queryFn: () => api(`/app/api/questions/${id}`),
  });
  const poolId = detail.data?.meta.poolId;
  const pool = useQuery<PoolDetail>({
    queryKey: poolKey(poolId),
    queryFn: () => api(`/app/api/pools/${poolId!}`),
    enabled: poolId !== undefined,
  });
  /*
   * A pool shared with me as `reader` (`PoolDetail.role`, the same predicate
   * `PoolView` uses for its own list). The question is READABLE — that is the
   * point of sharing — so the screen stays whole: the form, the properties
   * and the Try tab are all there, simply not writable. Nothing is hidden
   * except the actions that would be refused.
   *
   * The query is the one the pool screen already filled, so this costs no
   * request; while it is in flight the screen is writable-looking for a
   * moment, and the server refuses anyway (`staffAccess` / the pool role) —
   * this is chrome, never the rule.
   */
  const readOnly = pool.data?.role === "reader";

  // `DraftSaved.updatedAt` of the last write THIS editor made. It is what
  // tells our own draft apart from a foreign one when the question query
  // comes back (see the effect below).
  const ownStamp = useRef<string | null>(null);

  const save = useCallback(
    async (value: Draft) => {
      const saved = await api<DraftSaved>(`/app/api/questions/${id}/draft`, {
        method: "PUT",
        body: JSON.stringify({ config: value.config, explanation: value.explanation }),
      });
      ownStamp.current = saved.updatedAt;
      setIssues(saved.issues);
      return saved;
    },
    [id],
  );

  // `enabled: false` for a reader: not one `PUT /draft` leaves the browser,
  // whatever a control that slipped through would do to the local draft.
  const autosave = useAutosave<Draft>({
    value: draft ?? { config: null, explanation: "" },
    save,
    enabled: draft !== null && !readOnly,
  });

  /**
   * The draft that arrives from the server replaces the local copy — that is
   * how "restore v2 into the draft" and an edit made in another tab land on
   * screen. Two guards keep it from eating what the teacher is writing:
   *
   * - **our own echo is ignored.** `PUT /draft` makes the API emit a pool
   *   hint, `live.ts` invalidates every query, this one refetches and comes
   *   back carrying a NEW `updatedAt`. Replacing the local draft with it
   *   would hand `useAutosave` a new reference, which saves again, which
   *   hints again: an endless round trip. So anything not strictly newer
   *   than the stamp OUR last save returned is our own writing coming home.
   * - **a dirty draft is never overwritten.** While something is typed or on
   *   the wire, the local copy is the ahead one, whatever the server says.
   */
  const serverDraft = detail.data?.draft;
  const serverStamp = serverDraft?.updatedAt;
  const { dirty, adopt } = autosave;
  useEffect(() => {
    if (!serverDraft || !serverStamp) return;
    if (dirty) return;
    if (ownStamp.current !== null && new Date(serverStamp) <= new Date(ownStamp.current)) return;
    const next = { config: serverDraft.config, explanation: serverDraft.explanation };
    // Shown, never saved back: it is already what the server holds. Saving
    // it would stamp the draft AFTER the publication that just produced it,
    // and the question would read "unpublished changes" forever (#72, #74).
    adopt(next);
    setLocalDraft(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stamp is the identity of a draft
  }, [serverStamp]);

  const setDraft = useCallback((next: SetStateAction<Draft | null>) => {
    setEdited(true);
    setLocalDraft(next);
  }, []);

  return { detail, pool, poolId, readOnly, draft, setDraft, autosave, issues, edited };
}
