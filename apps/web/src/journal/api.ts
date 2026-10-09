/**
 * The web side of the journal's staff routes (M4-03): the staff payload the
 * classroom page, its Settings and the reader share (one cache entry,
 * `journalKey(id, "staff")`), the refusals worded, and Refresh.
 *
 * The routes exist on every platform (a Quiz-mode journal needs no GitHub,
 * ADR-057); `use` and `refresh` only with Quiz's GitHub App.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  assetContentType,
  encodeJournalPath,
  JournalNameTaken,
  JournalRefusal,
  type JournalErrorCode,
  type JournalDeletedPage,
  type JournalFileWritten,
  type JournalPageAdd,
  type JournalPageSave,
  type JournalPreview,
  type JournalPreviewResult,
  type JournalRemoveQuery,
  type JournalRepository,
  type JournalRestore,
  type JournalRevisionContent,
  type JournalRevisionList,
  type JournalStaff,
  type JournalStudent,
} from "@quiz/contracts";
import { journalAssetUrl } from "@quiz/docrender/assets";

import { api, ApiError } from "../api";
import type { TFunction } from "../i18n";
import { journalDeletedKey, journalKey, journalPageKey, journalRevisionKey, journalRevisionsKey } from "../queryKeys";
import { JOURNAL_ERRORS } from "./words";

/** `/app/api/classrooms/:id/journal`, the base of every journal route. */
export const journalBase = (classroomId: string) => `/app/api/classrooms/${classroomId}/journal`;

/** The payload a journal read asks for: the staff's, or the student's (`?view=student`, which can only narrow, ADR-018). */
export type JournalView = "staff" | "student";
interface JournalOf {
  staff: JournalStaff;
  student: JournalStudent;
}

/** The query string of a journal read in `view`: the student payload is asked for, the staff one is the default. */
export const journalQuery = (view: JournalView): string => (view === "student" ? "?view=student" : "");

/** `GET /classrooms/:id/journal` in the payload `view` names: whether there is a journal, which, and its navigation. */
export function useClassroomJournal<V extends JournalView>(classroomId: string, view: V) {
  return useQuery<JournalOf[V]>({
    queryKey: journalKey(classroomId, view),
    queryFn: () => api(`${journalBase(classroomId)}${journalQuery(view)}`),
  });
}

/** `GET /classrooms/:id/journal` as the staff read it: whether there is a journal, and which. */
export const useStaffJournal = (classroomId: string) => useClassroomJournal(classroomId, "staff");

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
// The editor's routes (F-JRN-10, F-JRN-11), Quiz mode only (ADR-057: a
// GitHub-mode journal is edited on GitHub). Every write ends with the
// journal's cache entry invalidated, pages and revisions included: the
// navigation, the hidden pages and the history all move with a save.

/** `…/journal/pages/<path>`, the path encoded segment by segment. */
export const journalPageUrl = (classroomId: string, path: string) =>
  `${journalBase(classroomId)}/pages/${encodeJournalPath(path)}`;

/**
 * Save (`PUT …/pages/*`): the page against the version the editor opened
 * (`baseVersion`). A 409 `conflict` leaves everything as it was, and the
 * caller keeps the draft.
 */
export function useJournalSave(classroomId: string, path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: JournalPageSave) =>
      api<JournalFileWritten>(journalPageUrl(classroomId, path), { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (written) => afterWrite(qc, classroomId, written),
  });
}

/** Add a page (`POST …/pages`): an empty file, or one holding its title as a heading. */
export function useJournalAddPage(classroomId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: JournalPageAdd) =>
      api<JournalFileWritten>(`${journalBase(classroomId)}/pages`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (written) => afterWrite(qc, classroomId, written),
  });
}

/**
 * After a page was written: the page the response carries goes into the
 * cache at once, so the reader shows it without waiting; then the journal is
 * read again.
 */
async function afterWrite(qc: QueryClient, classroomId: string, written: JournalFileWritten): Promise<void> {
  if (written.page) qc.setQueryData(journalPageKey(classroomId, "staff", written.path), written.page);
  await qc.invalidateQueries({ queryKey: journalKey(classroomId, "staff") });
}

/** Delete a page (`DELETE …/pages/*`); its revisions stay, so it can come back (`deleted`). */
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
 * A file stored in the journal at `path` (`POST …/assets/*`): the raw
 * bytes, declared with exactly the content type of the path's extension,
 * which is what the route checks (`JournalUploadHeaders`).
 */
export function uploadJournalAsset(classroomId: string, path: string, file: Blob): Promise<JournalFileWritten> {
  return api<JournalFileWritten>(journalAssetUrl(classroomId, path), {
    method: "POST",
    body: new Blob([file], { type: assetContentType(path) }),
  });
}

// ------------------------------------------------------------------ revisions (Quiz mode)
// ADR-057: one revision per save, listed and restored by the staff.

/** `GET …/revisions/*`: a page's revisions, newest first, metadata only. */
export function useJournalRevisions(classroomId: string, path: string) {
  return useQuery<JournalRevisionList>({
    queryKey: journalRevisionsKey(classroomId, path),
    queryFn: () => api(`${journalBase(classroomId)}/revisions/${encodeJournalPath(path)}`),
  });
}

/** `GET …/revision/:id`: one revision with its markdown. */
export function useJournalRevision(classroomId: string, revisionId: string | null) {
  return useQuery<JournalRevisionContent>({
    queryKey: journalRevisionKey(classroomId, revisionId ?? ""),
    queryFn: () => api(`${journalBase(classroomId)}/revision/${revisionId!}`),
    enabled: revisionId !== null,
    // A revision never changes.
    staleTime: Infinity,
  });
}

/** `GET …/deleted`: the pages a revision can bring back. */
export function useJournalDeleted(classroomId: string) {
  return useQuery<JournalDeletedPage[]>({
    queryKey: journalDeletedKey(classroomId),
    queryFn: () => api(`${journalBase(classroomId)}/deleted`),
  });
}

/** `POST …/restore`: a revision becomes the page again (a save; a deleted page comes back). */
export function useJournalRestore(classroomId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (revisionId: string) =>
      api<JournalFileWritten>(`${journalBase(classroomId)}/restore`, {
        method: "POST",
        body: JSON.stringify({ revisionId } satisfies JournalRestore),
      }),
    onSuccess: (written) => afterWrite(qc, classroomId, written),
  });
}

/**
 * `url`, with the `?confirm=` of a removal that destroys a Quiz-mode
 * journal's pages: the journal's own (F-JRN-04) and the classroom's
 * (F-ORG-09, `ClassroomDeleteQuery`, the same schema). Built from the
 * contract's type, so a renamed parameter breaks here at compile time.
 */
export function withConfirm(url: string, confirm?: string): string {
  if (confirm === undefined) return url;
  const query = { confirm } satisfies JournalRemoveQuery;
  return `${url}?${new URLSearchParams(query).toString()}`;
}

/**
 * Remove the journal (F-JRN-04): `confirm` is the classroom's name, typed,
 * which a Quiz-mode journal holding pages requires (409 `confirm_required`).
 */
export const journalRemoveUrl = (classroomId: string, confirm?: string) => withConfirm(journalBase(classroomId), confirm);

/** Whether removing this journal destroys the only copy of pages: the classroom's name must be typed. */
export const removalNeedsName = (journal: JournalStaff | undefined): boolean =>
  journal?.mode === "quiz" && journal.pageCount > 0;

/** "{count} pages", the one-page case worded on its own. */
export function pagesText(t: TFunction, count: number): string {
  return count === 1 ? t("journalSettings.pages.one") : t("journalSettings.pages", { count });
}

/** Markdown not saved yet (or a revision), rendered as the page at `path` would read (`POST …/preview`). */
export function previewJournalPage(classroomId: string, path: string, markdown: string): Promise<JournalPreviewResult> {
  const body: JournalPreview = { path, markdown };
  return api<JournalPreviewResult>(`${journalBase(classroomId)}/preview`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
