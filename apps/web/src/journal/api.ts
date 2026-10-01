/**
 * The web side of the journal's staff routes (M4-03): the staff payload the
 * classroom page, its Settings and the reader share (one cache entry,
 * `journalKey(id, "staff")`), the refusals worded, and Refresh.
 *
 * The routes exist only on a platform with Quiz's GitHub App: without one,
 * every one of them answers 404 (`githubAbsent`), and the screens then draw
 * no journal at all, as for a classroom that never had one.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  JournalNameTaken,
  JournalRefusal,
  type JournalErrorCode,
  type JournalRepository,
  type JournalStaff,
} from "@quiz/contracts";

import { api, ApiError, apiErrorMessage } from "../api";
import type { TFunction } from "../i18n";
import { journalKey } from "../queryKeys";
import { JOURNAL_ERRORS } from "./words";

/** `/app/api/classrooms/:id/journal`, the base of every journal route. */
export const journalBase = (classroomId: string) => `/app/api/classrooms/${classroomId}/journal`;

/** `GET /classrooms/:id/journal` as the staff read it: whether there is a journal, and which. */
export function useStaffJournal(classroomId: string) {
  return useQuery<JournalStaff>({
    queryKey: journalKey(classroomId, "staff"),
    queryFn: () => api(journalBase(classroomId)),
  });
}

/** The code of a refused journal write, or null for any other failure. */
export function journalRefusal(error: unknown): JournalErrorCode | null {
  if (!(error instanceof ApiError)) return null;
  const parsed = JournalRefusal.safeParse(error.body);
  return parsed.success ? parsed.data.error : null;
}

/** A refused journal write in the interface language; anything else as `apiErrorMessage` says it. */
export function journalErrorText(error: unknown, t: TFunction): string {
  const code = journalRefusal(error);
  return code ? t(JOURNAL_ERRORS[code]) : apiErrorMessage(error, t("error.server"));
}

/** The free name a create refused `name_taken` proposes instead (F-JRN-02), if that is the refusal. */
export function nameTakenSuggestion(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const parsed = JournalNameTaken.safeParse(error.body);
  return parsed.success ? parsed.data.suggestion : null;
}

/** How often the staff journal is read again while a Refresh is awaited, and for how long at most. */
export const REFRESH_POLL_MS = 3_000;
export const REFRESH_GIVE_UP_MS = 60_000;

/** What a synchronisation changes on the row, whatever its outcome: its state and when it ended. */
const syncMark = (repository: JournalRepository | null) =>
  repository ? `${repository.syncStatus}|${repository.lastSyncedAt ?? ""}` : null;

/**
 * Refresh (F-JRN-05): `POST …/refresh` answers 202 at once and the copy is
 * read in the background; its outcome is the row's sync state, which the
 * `journal` hint brings back. The write's own `mutation` hint arrives first
 * and refetches a row the synchronisation has not touched yet, so "waiting"
 * is not "until the next fetch" but "until the row's state or its last
 * synchronisation time moves" — every ingestion, ok or failed, writes both.
 * While it waits, the payload is read again every few seconds, in case a
 * hint is lost, and the wait gives up after a minute.
 */
export function useJournalRefresh(
  classroomId: string,
  repository: JournalRepository | null,
  onError: (error: unknown) => void,
) {
  const qc = useQueryClient();
  const mark = syncMark(repository);
  const [waitingOn, setWaitingOn] = useState<{ mark: string | null; at: number } | null>(null);
  const refresh = useMutation({
    mutationFn: () => api(`${journalBase(classroomId)}/refresh`, { method: "POST" }),
    onMutate: () => setWaitingOn({ mark, at: Date.now() }),
    // The pages hang under the key: a refresh may have changed any of them.
    onSuccess: () => qc.invalidateQueries({ queryKey: journalKey(classroomId, "staff") }),
    onError: (error) => {
      setWaitingOn(null);
      onError(error);
    },
  });

  const waiting = waitingOn !== null && waitingOn.mark === mark;
  useEffect(() => {
    if (waitingOn === null) return;
    if (waitingOn.mark !== mark) {
      setWaitingOn(null);
      return;
    }
    const poll = setInterval(
      () => void qc.invalidateQueries({ queryKey: journalKey(classroomId, "staff"), exact: true }),
      REFRESH_POLL_MS,
    );
    const giveUp = setTimeout(() => setWaitingOn(null), Math.max(0, waitingOn.at + REFRESH_GIVE_UP_MS - Date.now()));
    return () => {
      clearInterval(poll);
      clearTimeout(giveUp);
    };
  }, [waitingOn, mark, qc, classroomId]);

  return { refresh: () => refresh.mutate(), refreshing: refresh.isPending || waiting };
}
