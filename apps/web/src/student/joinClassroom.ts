import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { SelfEnrollQuery } from "@quiz/contracts";

import { api, refusalCodeOf } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { classroomKey, studentRootKey } from "../queryKeys";

/**
 * Join as student (ADR-018): the teacher takes a staff seat in a classroom
 * of their course, to walk the student flow without a second account. The
 * classroom page (teacher view), the student classroom page and the
 * `/take/:id` no-seat screen share it, so the conversion of a student line
 * holding the teacher's address is asked in one place: the server refuses
 * it as `409 student_line` until it is sent again with `?convert=1`.
 *
 * Resolves `true` once seated, `false` when the teacher declined the
 * conversion; the student pages and the teacher's classroom are read again.
 */
export function useJoinClassroom(classroomId: string, { onJoined }: { onJoined?: () => void } = {}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const path = `/app/api/classrooms/${classroomId}/self-enroll`;
  const enroll = (convert: boolean) =>
    api(convert ? `${path}?${new URLSearchParams({ convert: "1" } satisfies SelfEnrollQuery)}` : path, { method: "POST" });
  return useMutation({
    mutationFn: async (): Promise<boolean> => {
      try {
        await enroll(false);
        return true;
      } catch (error) {
        if (refusalCodeOf(error) !== "student_line") throw error;
        const ok = await confirm({
          title: t("roster.convert.title"),
          message: t("roster.convert.body"),
          confirmLabel: t("roster.convert.confirm"),
        });
        if (!ok) return false;
        await enroll(true);
        return true;
      }
    },
    onSuccess: async (joined) => {
      if (!joined) return;
      await Promise.all([
        qc.invalidateQueries({ queryKey: classroomKey(classroomId) }),
        qc.invalidateQueries({ queryKey: studentRootKey }),
      ]);
      toast(t("roster.joinDone"), "success");
      onJoined?.();
    },
    onError: toastError("roster.joinFailed"),
  });
}
