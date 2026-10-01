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
  assetContentType,
  encodeJournalPath,
  JOURNAL_ASSETS_PATH,
  JournalNameTaken,
  JournalRefusal,
  type JournalErrorCode,
  type JournalFileWritten,
  type JournalPageAdd,
  type JournalPageSave,
  type JournalPreviewResult,
  type JournalRepository,
  type JournalStaff,
} from "@quiz/contracts";

import { api, ApiError } from "../api";
import type { TFunction } from "../i18n";
import { journalKey, journalPageKey } from "../queryKeys";
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

/** A refused journal write in the interface language; anything else is the generic server error, never the server's text. */
export function journalErrorText(error: unknown, t: TFunction): string {
  const code = journalRefusal(error);
  return t(code ? JOURNAL_ERRORS[code] : "error.server");
}

/** The free name a create refused `name_taken` proposes instead (F-JRN-02), if that is the refusal. */
export function nameTakenSuggestion(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const parsed = JournalNameTaken.safeParse(error.body);
  return parsed.success ? parsed.data.suggestion : null;
}

/** How long a Refresh is awaited at most, should its `journal` hint never come. */
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
 * synchronisation time moves" — every ingestion, ok or failed, writes both
 * and raises the hint (`journalChanged`); a reconnect refetches everything
 * (ADR-005). The wait gives up after a minute all the same.
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
    const giveUp = setTimeout(() => setWaitingOn(null), Math.max(0, waitingOn.at + REFRESH_GIVE_UP_MS - Date.now()));
    return () => clearTimeout(giveUp);
  }, [waitingOn, mark]);

  return { refresh: () => refresh.mutate(), refreshing: refresh.isPending || waiting };
}

// ------------------------------------------------------------------ writes
// The editor's routes (M4-06, F-JRN-10, F-JRN-11). Every write ends with the
// journal's cache entry invalidated, pages included: the navigation, the
// hidden pages and the copy's head all move with a commit.

/** `…/journal/pages/<path>`, the path encoded segment by segment. */
export const journalPageUrl = (classroomId: string, path: string) =>
  `${journalBase(classroomId)}/pages/${encodeJournalPath(path)}`;

/**
 * Save (`PUT …/pages/*`): the page against the blob the editor opened. A
 * 409 `conflict` leaves everything as it was, and the caller keeps the
 * draft. The page the response carries, when the copy caught up with the
 * commit, goes into the cache at once, so the reader shows the saved text
 * without waiting for the refetch.
 */
export function useJournalSave(classroomId: string, path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: JournalPageSave) =>
      api<JournalFileWritten>(journalPageUrl(classroomId, path), { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: async (written) => {
      if (written.page) qc.setQueryData(journalPageKey(classroomId, "staff", path), written.page);
      await qc.invalidateQueries({ queryKey: journalKey(classroomId, "staff") });
    },
  });
}

/** Add a page (`POST …/pages`): an empty file, or one holding its title as a heading. */
export function useJournalAddPage(classroomId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: JournalPageAdd) =>
      api<JournalFileWritten>(`${journalBase(classroomId)}/pages`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async (written) => {
      if (written.page) qc.setQueryData(journalPageKey(classroomId, "staff", written.path), written.page);
      await qc.invalidateQueries({ queryKey: journalKey(classroomId, "staff") });
    },
  });
}

/** Delete a page (`DELETE …/pages/*`), against the blob the copy holds. */
export function useJournalDeletePage(classroomId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (path: string) => api<void>(journalPageUrl(classroomId, path), { method: "DELETE" }),
    onSuccess: async (_, path) => {
      qc.removeQueries({ queryKey: journalPageKey(classroomId, "staff", path) });
      await qc.invalidateQueries({ queryKey: journalKey(classroomId, "staff") });
    },
  });
}

/**
 * A file written into the repository at `path` (`POST …/assets/*`): the raw
 * bytes, declared with exactly the content type of the path's extension,
 * which is what the route checks (`JournalUploadHeaders`).
 */
export function uploadJournalAsset(classroomId: string, path: string, file: Blob): Promise<JournalFileWritten> {
  return api<JournalFileWritten>(`${JOURNAL_ASSETS_PATH(classroomId)}/${encodeJournalPath(path)}`, {
    method: "POST",
    body: new Blob([file], { type: assetContentType(path) }),
  });
}

/** Markdown not saved yet, rendered as the page at `path` would read (`POST …/preview`). */
export function previewJournalPage(classroomId: string, path: string, markdown: string): Promise<JournalPreviewResult> {
  return api<JournalPreviewResult>(`${journalBase(classroomId)}/preview`, {
    method: "POST",
    body: JSON.stringify({ path, markdown }),
  });
}
