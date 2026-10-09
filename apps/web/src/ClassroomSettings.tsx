/**
 * The teacher classroom's Settings tab (F-ORG-13, D24), in settings rows
 * (DESIGN.md, "Settings row"). It holds what the header held — rename,
 * archive, delete — and the drill switch the Drill tab held, plus the GitHub
 * section and the Journal section (M4-05, `journal/JournalSettings.tsx`).
 *
 * Its one accent is "Connect to GitHub" while the classroom is not
 * connected; once it is, nothing here is accented (a classroom connected for
 * its projects is not pushed towards a journal). Delete is a `danger-quiet`
 * button whose confirmation is the `danger` one: red ink says it destroys,
 * while a red fill in the row would compete with that one accent, which the
 * squint test must find alone. Archive restores, so it stays `secondary`.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, School, Trash2 } from "lucide-react";
import { useState } from "react";

import { ClassroomPatch, type ClassroomDetail } from "@quiz/contracts";

import { api } from "./api";
import { useConfirm } from "./confirm";
import { ClassroomDrillSetting } from "./drill/ClassroomDrillSetting";
import { ClassroomGithub } from "./github/ClassroomGithub";
import { useT } from "./i18n";
import { pagesText, removalNeedsName, useStaffJournal, withConfirm } from "./journal/api";
import { JournalSettings } from "./journal/JournalSettings";
import { useErrorToast, useToast } from "./notify";
import { useIsCourseOwner } from "./course/parts";
import { invalidateHint } from "./realtime/hints";
import type { Navigate } from "./router";
import { Button, Card, Field, FormDialog, SectionHeading, SettingRow } from "./ui";

export function ClassroomSettings({
  room,
  navigate,
  connecting,
  onConnecting,
}: {
  room: ClassroomDetail;
  navigate: Navigate;
  /** The GitHub connect sheet is open (`?connect=1`). */
  connecting: boolean;
  onConnecting: (open: boolean) => void;
}) {
  const t = useT();
  const [renaming, setRenaming] = useState(false);
  return (
    <div className="max-w-3xl space-y-8">
      <section className="space-y-3">
        <SectionHeading icon={School} title={t("classroomSettings.general")} />
        <Card className="divide-y divide-line px-5">
          <SettingRow title={t("classroomSettings.name")} desc={room.name}>
            <Button variant="secondary" onClick={() => setRenaming(true)}>
              {t("classroomSettings.rename")}
            </Button>
          </SettingRow>
          <ClassroomDrillSetting room={room} />
        </Card>
      </section>

      <ClassroomGithub room={room} connecting={connecting} onConnecting={onConnecting} />

      {/* F-JRN-02 to F-JRN-05: enabled once the classroom is connected, never accented. */}
      <JournalSettings room={room} />

      <LifecycleSection room={room} navigate={navigate} />

      {renaming ? <RenameDialog room={room} onClose={() => setRenaming(false)} /> : null}
    </div>
  );
}

/** The name, in a one-field dialog (the header shows it; it no longer edits it). */
function RenameDialog({ room, onClose }: { room: ClassroomDetail; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const [name, setName] = useState(room.name);
  const body = ClassroomPatch.safeParse({ name: name.trim() });
  const rename = useMutation({
    mutationFn: () =>
      api(`/app/api/classrooms/${room.id}`, { method: "PATCH", body: JSON.stringify(body.data) }),
    // The name is on the course page and in the sidebar too, so everything
    // that carries a classroom is dropped.
    onSuccess: async () => {
      await invalidateHint(qc, ["classrooms"]);
      toast(t("classroomSettings.renamed"), "success");
      onClose();
    },
    onError: toastError("classrooms.renameFailed"),
  });
  return (
    <FormDialog
      title={t("classroomSettings.renameTitle")}
      onClose={onClose}
      onSubmit={() => rename.mutate()}
      submitLabel={t("common.save")}
      submitting={rename.isPending}
      canSubmit={body.success && name.trim() !== room.name}
      dense
    >
      <Field
        label={t("classrooms.name")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        fullWidth
      />
    </FormDialog>
  );
}

/**
 * Archive (reversible, no confirmation) and delete (confirmed, `danger`).
 * Deleting is an owner's of the course (ADR-068): an assistant has Archive only.
 */
function LifecycleSection({ room, navigate }: { room: ClassroomDetail; navigate: Navigate }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const archived = room.archivedAt !== null;
  const isOwner = useIsCourseOwner(room.course.id);
  // A Quiz-mode journal holding pages goes with the classroom, and it is the
  // only copy of them: the name is typed, and sent (F-ORG-09, F-JRN-04).
  const journal = useStaffJournal(room.id);
  const typed = removalNeedsName(journal.data);
  const archive = useMutation({
    mutationFn: (to: "archive" | "unarchive") => api(`/app/api/classrooms/${room.id}/${to}`, { method: "POST" }),
    onSuccess: async (_, to) => {
      await invalidateHint(qc, ["classrooms"]);
      toast(t(to === "archive" ? "classroomSettings.archived" : "classroomSettings.restored"), "success");
    },
    onError: toastError("classroomSettings.archiveFailed"),
  });
  const remove = useMutation({
    mutationFn: (confirm?: string) =>
      api(withConfirm(`/app/api/classrooms/${room.id}`, confirm), { method: "DELETE" }),
    onSuccess: async () => {
      await invalidateHint(qc, ["classrooms"]);
      navigate({ view: "home" });
    },
    onError: toastError("classroomSettings.deleteFailed"),
  });
  return (
    <section className="space-y-3">
      <SectionHeading title={t(isOwner ? "classroomSettings.lifecycle" : "classroomSettings.archive")} />
      <Card className="divide-y divide-line px-5">
        <SettingRow
          title={t("classroomSettings.archive")}
          desc={archived ? t("classroomSettings.archivedDesc") : t("classroomSettings.archiveDesc")}
        >
          <Button
            variant="secondary"
            loading={archive.isPending}
            onClick={() => archive.mutate(archived ? "unarchive" : "archive")}
          >
            {archived ? (
              <>
                <ArchiveRestore /> {t("classrooms.unarchive")}
              </>
            ) : (
              <>
                <Archive /> {t("classrooms.archive")}
              </>
            )}
          </Button>
        </SettingRow>
        {isOwner ? (
          <SettingRow title={t("classroomSettings.delete")} desc={t("classroomSettings.deleteDesc")}>
            <Button
              variant="danger-quiet"
              loading={remove.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: t("classrooms.deleteConfirm", { name: room.name }),
                    ...(typed
                      ? {
                          message: t("classroomSettings.deleteJournal", {
                            pages: pagesText(t, journal.data!.pageCount),
                          }),
                          typeToConfirm: room.name,
                        }
                      : {}),
                    confirmLabel: t("common.delete"),
                    danger: true,
                  })
                ) {
                  remove.mutate(typed ? room.name : undefined);
                }
              }}
            >
              <Trash2 /> {t("classrooms.delete")}
            </Button>
          </SettingRow>
        ) : null}
      </Card>
    </section>
  );
}
