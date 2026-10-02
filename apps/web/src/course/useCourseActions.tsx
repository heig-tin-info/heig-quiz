import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, Trash2, UserMinus, UserPlus } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { CourseSummary, EvaluationTemplate } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { MenuItem, Person } from "../ui";
import { coursesKey, courseTemplatesKey } from "../queryKeys";
import { AddStaffModal, NewClassroomModal } from "./modals";

/**
 * What a course offers beyond being opened: a classroom, a colleague, its own
 * deletion. The card, the table row of the list view and the course page
 * share this ONE copy, so the readings of the same course cannot offer
 * different things; the hook owns the two dialogs those items open as well.
 *
 * `items` are the actions of the COURSE and `staffActions` those of one
 * person, because that is where each is read: the two icon buttons sit beside
 * the title, and "remove from the staff" waits inside the card of the
 * colleague it is about, where the name is already written.
 *
 * The course page reads the same actions by name, in its tabs rather than a
 * menu: `addStaff` on Members, `setHidden` and `remove` on Settings.
 *
 * `onDeleted` runs once the course is gone: the course page leaves for the
 * Courses home rather than stay on a course that no longer exists.
 */
export function useCourseActions(
  course: CourseSummary,
  { onDeleted }: { onDeleted?: () => void } = {},
): {
  items: MenuItem[];
  staffActions: (person: Person) => MenuItem[];
  newClassroom: () => void;
  addStaff: () => void;
  setHidden: (hidden: boolean) => void;
  hiding: boolean;
  remove: () => Promise<void>;
  removing: boolean;
  dialogs: ReactNode;
} {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toastError = useErrorToast();
  const [newRoom, setNewRoom] = useState(false);
  const [newStaff, setNewStaff] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: coursesKey });
  const removeCourse = useMutation({
    mutationFn: () => api(`/app/api/courses/${course.id}`, { method: "DELETE" }),
    // Away first, then the list: the page would otherwise redraw once as
    // "this course does not exist" on its way out.
    onSuccess: async () => {
      onDeleted?.();
      await invalidate();
    },
  });
  const removeStaff = useMutation({
    mutationFn: (userId: string) =>
      api(`/app/api/courses/${course.id}/staff/${userId}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const toast = useToast();
  // A hidden course leaves the list at once, so the toast says where it went.
  const hide = useMutation({
    mutationFn: (hidden: boolean) =>
      api(`/app/api/courses/${course.id}/${hidden ? "hide" : "unhide"}`, { method: "POST" }),
    onSuccess: async (_data, hidden) => {
      await invalidate();
      if (hidden) toast(t("courses.hiddenToast", { code: course.code }), "success");
    },
    onError: toastError("error.save"),
  });

  const remove = async () => {
    // The confirmation names what else goes (ADR-031): the course's
    // templates cascade with it, and neither the card nor the table row
    // lists them. A count that could not be read is not confirmed as
    // zero.
    let templates: number;
    try {
      templates = (
        await qc.fetchQuery<EvaluationTemplate[]>({
          queryKey: courseTemplatesKey(course.id),
          queryFn: () => api(`/app/api/courses/${course.id}/templates`),
        })
      ).length;
    } catch (error) {
      toastError("error.server")(error);
      return;
    }
    if (
      await confirm({
        title:
          templates === 0
            ? t("courses.deleteConfirm", { name: course.name })
            : t(
                templates === 1
                  ? "courses.deleteConfirmTemplates.one"
                  : "courses.deleteConfirmTemplates",
                { name: course.name, n: templates },
              ),
        confirmLabel: t("common.delete"),
        cancelLabel: t("common.cancel"),
        danger: true,
      })
    ) {
      removeCourse.mutate();
    }
  };

  const addStaff = () => setNewStaff(true);
  const setHidden = (hidden: boolean) => hide.mutate(hidden);

  return {
    newClassroom: () => setNewRoom(true),
    addStaff,
    setHidden,
    hiding: hide.isPending,
    remove,
    removing: removeCourse.isPending,
    // The server refuses to empty a staff (409 `last_staff`); an action that
    // can only fail is not offered at all, so the last colleague standing has
    // a card with nothing in it but their address.
    staffActions: (person) =>
      course.staff.length <= 1
        ? []
        : [
            {
              label: t("courses.staffRemove"),
              icon: UserMinus,
              danger: true,
              onSelect: async () => {
                if (
                  await confirm({
                    title: t("courses.staffRemoveConfirm", {
                      name: `${person.givenName} ${person.familyName}`,
                      course: course.name,
                    }),
                    confirmLabel: t("courses.staffRemove"),
                    cancelLabel: t("common.cancel"),
                  })
                ) {
                  removeStaff.mutate(person.userId);
                }
              },
            },
          ],
    items: [
      {
        label: t("courses.staffAdd"),
        icon: UserPlus,
        onSelect: addStaff,
      },
      course.hidden
        ? { label: t("courses.unhide"), icon: Eye, onSelect: () => setHidden(false) }
        : {
            label: t("courses.hide"),
            description: t("courses.hideHint"),
            icon: EyeOff,
            onSelect: () => setHidden(true),
          },
      {
        label: t("courses.delete"),
        icon: Trash2,
        danger: true,
        separator: true,
        onSelect: remove,
      },
    ],
    dialogs: (
      <>
        {newRoom ? <NewClassroomModal course={course} onClose={() => setNewRoom(false)} /> : null}
        {newStaff ? <AddStaffModal course={course} onClose={() => setNewStaff(false)} /> : null}
      </>
    ),
  };
}
