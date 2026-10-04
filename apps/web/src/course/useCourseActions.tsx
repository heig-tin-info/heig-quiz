import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, LogOut, Trash2, UserCog, UserMinus, UserPlus } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { CourseRole, CourseSummary, EvaluationTemplate, StaffPatch } from "@quiz/contracts";

import { api, useMe } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { MenuItem } from "../ui";
import { coursesKey, courseTemplatesKey } from "../queryKeys";
import { AddStaffModal, NewClassroomModal } from "./modals";
import { useIsCourseOwner } from "./parts";

/** One seat of the course's staff, with its role. */
type StaffMember = CourseSummary["staff"][number];

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
 * What is offered follows the caller's role on the course (ADR-068): an
 * owner runs the course — its staff and their roles, its classrooms, its
 * deletion — and an assistant is offered only what they may do, hiding the
 * course and leaving it. The server refuses the rest anyway
 * (`owner_required`); a button that can only fail is not drawn.
 *
 * `onGone` runs once the course is out of the caller's reach — deleted, or
 * left: the course page goes to the Courses home rather than stay on a
 * course it can no longer show.
 */
export function useCourseActions(
  course: CourseSummary,
  { onGone }: { onGone?: () => void } = {},
): {
  /** The caller owns the course (ADR-068). */
  isOwner: boolean;
  items: MenuItem[];
  staffActions: (member: StaffMember) => MenuItem[];
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
  const meId = useMe().data?.id;
  const isOwner = useIsCourseOwner(course.id);
  const [newRoom, setNewRoom] = useState(false);
  const [newStaff, setNewStaff] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: coursesKey });
  const removeCourse = useMutation({
    mutationFn: () => api(`/app/api/courses/${course.id}`, { method: "DELETE" }),
    // Away first, then the list: the page would otherwise redraw once as
    // "this course does not exist" on its way out.
    onSuccess: async () => {
      onGone?.();
      await invalidate();
    },
  });
  const removeStaff = useMutation({
    mutationFn: (userId: string) =>
      api(`/app/api/courses/${course.id}/staff/${userId}`, { method: "DELETE" }),
    onSuccess: async (_data, userId) => {
      // Leaving: away first, as for a deletion — the course is no longer ours.
      if (userId === meId) onGone?.();
      await invalidate();
    },
    onError: toastError("error.save"),
  });
  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: CourseRole }) => {
      const body: StaffPatch = { role };
      return api(`/app/api/courses/${course.id}/staff/${userId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    },
    onSuccess: invalidate,
    onError: toastError("error.save"),
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

  const owners = course.staff.filter((p) => p.role === "owner").length;

  /**
   * One seat's actions. The server keeps the last owner (409 `last_owner`);
   * an action that can only fail is not offered, so the sole owner's card
   * offers nothing that would leave the course without one. An owner
   * changes roles and removes anyone; an assistant only leaves.
   */
  const staffActions = (person: StaffMember): MenuItem[] => {
    const self = person.userId === meId;
    const soleOwner = person.role === "owner" && owners <= 1;
    if (!isOwner && !self) return [];
    const name = `${person.givenName} ${person.familyName}`;
    const next: CourseRole = person.role === "owner" ? "assistant" : "owner";
    const roleChange: MenuItem[] =
      !isOwner || soleOwner
        ? []
        : [
            {
              label: t(next === "owner" ? "courses.makeOwner" : "courses.makeAssistant"),
              icon: UserCog,
              onSelect: () => setRole.mutate({ userId: person.userId, role: next }),
            },
          ];
    const removal: MenuItem[] = soleOwner
      ? []
      : [
          {
            label: t(self ? "courses.leave" : "courses.staffRemove"),
            icon: self ? LogOut : UserMinus,
            danger: true,
            onSelect: async () => {
              if (
                await confirm({
                  title: self
                    ? t("courses.leaveConfirm", { course: course.name })
                    : t("courses.staffRemoveConfirm", { name, course: course.name }),
                  confirmLabel: t(self ? "courses.leave" : "courses.staffRemove"),
                  cancelLabel: t("common.cancel"),
                })
              ) {
                removeStaff.mutate(person.userId);
              }
            },
          },
        ];
    return [...roleChange, ...removal];
  };

  const visibility: MenuItem = course.hidden
    ? { label: t("courses.unhide"), icon: Eye, onSelect: () => setHidden(false) }
    : {
        label: t("courses.hide"),
        description: t("courses.hideHint"),
        icon: EyeOff,
        onSelect: () => setHidden(true),
      };

  return {
    isOwner,
    newClassroom: () => setNewRoom(true),
    addStaff,
    setHidden,
    hiding: hide.isPending,
    remove,
    removing: removeCourse.isPending,
    staffActions,
    items: isOwner
      ? [
          { label: t("courses.staffAdd"), icon: UserPlus, onSelect: addStaff },
          visibility,
          {
            label: t("courses.delete"),
            icon: Trash2,
            danger: true,
            separator: true,
            onSelect: remove,
          },
        ]
      : [visibility],
    dialogs: (
      <>
        {newRoom ? <NewClassroomModal course={course} onClose={() => setNewRoom(false)} /> : null}
        {newStaff ? <AddStaffModal course={course} onClose={() => setNewStaff(false)} /> : null}
      </>
    ),
  };
}
