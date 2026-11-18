/*
 * The Sync dialog (ADR-132 §10, F-PROJ-12): what the sync would send, read
 * before it is sent, and the teacher's message to the students.
 *
 * Opening it reads the preview (`GET …/sync/preview`): the sync's own
 * transform stopped before its commit, per handed-out branch. The list is
 * grouped added / modified / deleted, the protected paths marked; two notes
 * say what each kind of path does, each only when such a path is listed.
 * Its one primary action is Sync. With nothing to send it is held, unless
 * the last sync failed somewhere: a sync then retries those repositories.
 *
 * The four decisions:
 *   - Type: the group headings at 13 px semibold over 12 px mono paths.
 *   - Color: the accent is the Sync button alone; a protected path wears a
 *     zinc badge, never a warning.
 *   - Space: 4 between paths, 16 between groups, 20 around the message.
 *   - Finish: the dialog's hairlines, the list in a `surface-2` well.
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CircleCheck, RefreshCw } from "lucide-react";
import { useId, useState } from "react";

import { projectIsVisible, SYNC_CHANGES, SYNC_MESSAGE_MAX, type SyncChange } from "@quiz/domain";
import type { ProjectDetail, ProjectSyncPreview } from "@quiz/contracts";

import { api } from "../api";
import { useT, type Dict } from "../i18n";
import { projectSyncPreviewKey } from "../queryKeys";
import { Alert, Badge, Button, FieldLabel, Modal, Skeleton, Textarea } from "../ui";
import { refusalMessage } from "./projectPage";

const HEADING: Record<SyncChange, keyof Dict> = {
  added: "project.syncDialog.added",
  modified: "project.syncDialog.modified",
  deleted: "project.syncDialog.deleted",
};

/** Which of the two notes apply: a protected path listed, another path listed (or counted beyond the cap). */
function syncNotes(preview: ProjectSyncPreview): { protectedNote: boolean; otherNote: boolean } {
  const paths = preview.branches.flatMap((b) => b.paths);
  return {
    // Graded in the distribution's version, merged or not: a criteria v3 project only (ADR-132 §2).
    protectedNote: preview.protectedGraded && paths.some((p) => p.protected),
    otherNote: paths.some((p) => !p.protected) || preview.branches.some((b) => b.more > 0),
  };
}

/** Nothing to send: every branch's list empty. */
const nothingToSend = (preview: ProjectSyncPreview): boolean => preview.branches.every((b) => b.paths.length === 0 && b.more === 0);

export function SyncDialog({
  project,
  onSync,
  syncing,
  onClose,
}: {
  project: ProjectDetail;
  onSync: (message: string) => void;
  syncing: boolean;
  onClose: () => void;
}) {
  const t = useT();
  // The last message, kept unless edited: a retry never clears it by accident.
  const [message, setMessage] = useState(project.sync.message?.text ?? "");
  const messageId = useId();
  const preview = useQuery<ProjectSyncPreview>({
    queryKey: projectSyncPreviewKey(project.id),
    queryFn: () => api(`/app/api/projects/${project.id}/sync/preview`),
    // Read once per opening: it clones the source and the distribution.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  /** What the last sync could not reach: a sync with nothing new still retries them (F-PROJ-12). */
  const failed = project.sync.last?.failed ?? 0;
  const empty = preview.data ? nothingToSend(preview.data) : false;
  const canSync = preview.isSuccess && (!empty || failed > 0);

  return (
    <Modal
      title={t("project.syncDialog.title")}
      size="lg"
      scroll
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => onSync(message.trim())} disabled={!canSync} loading={syncing}>
            <RefreshCw /> {t("project.sync")}
          </Button>
        </>
      }
    >
      <div className="space-y-5" data-testid="sync-dialog">
        {preview.isPending ? (
          <div className="space-y-2" role="status" aria-label={t("project.syncDialog.reading")}>
            <p className="text-[13px] text-fg-muted">{t("project.syncDialog.reading")}</p>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : preview.isError ? (
          <Alert
            tone="danger"
            icon={AlertTriangle}
            title={t("project.syncDialog.failed")}
            action={
              <Button size="sm" variant="secondary" onClick={() => void preview.refetch()} loading={preview.isFetching}>
                <RefreshCw /> {t("common.retry")}
              </Button>
            }
          >
            {refusalMessage(preview.error, t)}
          </Alert>
        ) : empty ? (
          <div className="flex items-start gap-3 rounded-card bg-surface-2 px-4 py-3 text-sm" data-testid="sync-nothing">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <div>
              <p className="font-medium">{t("project.syncDialog.empty")}</p>
              <p className="text-fg-muted">
                {failed === 1
                  ? t("project.syncDialog.retryFailed.one")
                  : failed > 1
                    ? t("project.syncDialog.retryFailed", { n: failed })
                    : t("project.syncDialog.emptyBody")}
              </p>
            </div>
          </div>
        ) : (
          <ChangeList preview={preview.data} />
        )}

        {canSync && projectIsVisible(project.state) ? (
          <div className="flex flex-col gap-1.5">
            <FieldLabel htmlFor={messageId} hint={`${message.length}/${SYNC_MESSAGE_MAX}`}>
              {t("project.syncDialog.message")}
            </FieldLabel>
            <Textarea
              id={messageId}
              value={message}
              maxLength={SYNC_MESSAGE_MAX}
              onChange={(e) => setMessage(e.target.value)}
              aria-describedby={`${messageId}-hint`}
              rows={3}
            />
            <p id={`${messageId}-hint`} className="text-xs text-fg-muted">
              {t("project.syncDialog.messageHint")}
            </p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

/** The paths per branch, grouped by what the sync does to them, and the notes that apply. */
function ChangeList({ preview }: { preview: ProjectSyncPreview }) {
  const t = useT();
  const { protectedNote, otherNote } = syncNotes(preview);
  const several = preview.branches.length > 1;
  return (
    <div className="space-y-4">
      {preview.branches.map((b) => (
        <section key={b.branch} className="space-y-4" aria-label={t("project.syncDialog.branch", { branch: b.branch })}>
          {several ? <h3 className="font-mono text-xs text-fg-muted">{t("project.syncDialog.branch", { branch: b.branch })}</h3> : null}
          {b.paths.length === 0 && b.more === 0 ? <p className="text-[13px] text-fg-muted">{t("project.syncDialog.empty")}</p> : null}
          {SYNC_CHANGES.map((change) => {
            const paths = b.paths.filter((p) => p.change === change);
            if (paths.length === 0) return null;
            return (
              <div key={change} className="space-y-1.5">
                <h4 className="flex items-baseline gap-2 text-[13px] font-semibold">
                  {t(HEADING[change])} <span className="font-normal tabular-nums text-fg-faint">{paths.length}</span>
                </h4>
                <ul className="space-y-1 rounded-card bg-surface-2 px-3 py-2">
                  {paths.map((p) => (
                    <li key={p.path} className="flex items-center gap-2">
                      <span className="min-w-0 break-all font-mono text-xs">{p.path}</span>
                      {p.protected ? <Badge tone="zinc">{t("project.syncDialog.protected")}</Badge> : null}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {b.more > 0 ? (
            <p className="text-xs text-fg-muted">{b.more === 1 ? t("project.syncDialog.more.one") : t("project.syncDialog.more", { n: b.more })}</p>
          ) : null}
        </section>
      ))}
      {protectedNote || otherNote ? (
        <ul className="space-y-1.5 border-t border-line pt-3 text-[13px] text-fg-muted">
          {protectedNote ? <li data-testid="sync-note-protected">{t("project.syncDialog.note.protected")}</li> : null}
          {otherNote ? <li data-testid="sync-note-other">{t("project.syncDialog.note.other")}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
