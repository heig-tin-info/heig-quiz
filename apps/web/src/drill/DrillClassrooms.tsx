/**
 * The classrooms the drill draws from, each with its switch (ADR-041 §6):
 * the student is in by default and may leave one classroom's drill — and
 * come back in one action.
 *
 * Two things are said here because the product owner decided they must be
 * (ADR-041 §8, §10 (k), §13 item 5): the teacher sees the drill activity, and
 * leaving does not erase what was recorded — the confirmation says that the
 * past activity stays visible and that the teacher sees the opt-out, and when.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eye } from "lucide-react";

import type { DrillClassroom } from "@quiz/contracts";

import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { drillRootKey } from "../queryKeys";
import { Card, isoDateParts, SectionHeading, SettingRow, Switch } from "../ui";
import { setOptOut } from "./api";

export function DrillClassrooms({ rooms }: { rooms: readonly DrillClassroom[] }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();

  const change = useMutation({
    mutationFn: ({ room, optedOut }: { room: DrillClassroom; optedOut: boolean }) =>
      setOptOut(room.classroomId, optedOut),
    onSuccess: async (room) => {
      await qc.invalidateQueries({ queryKey: drillRootKey });
      toast(
        t(room.optedOutAt === null ? "drill.optIn.done" : "drill.optOut.done", {
          name: room.classroomName,
        }),
        "success",
      );
    },
    onError: toastError("drill.failed"),
  });

  const toggle = async (room: DrillClassroom, inDrill: boolean) => {
    // Back in: one action, nothing to warn about.
    if (inDrill) return change.mutate({ room, optedOut: false });
    const ok = await confirm({
      title: t("drill.optOut.title", { name: room.classroomName }),
      message: (
        <div className="space-y-2">
          <p>{t("drill.optOut.body")}</p>
          <p>{t("drill.optOut.past")}</p>
          <p>{t("drill.optOut.seen")}</p>
          <p className="text-fg-muted">{t("drill.optOut.back")}</p>
        </div>
      ),
      confirmLabel: t("drill.optOut.confirm"),
    });
    if (ok) change.mutate({ room, optedOut: true });
  };

  return (
    <section className="space-y-3">
      <SectionHeading title={t("drill.rooms.title")} />
      <Card className="divide-y divide-line px-4">
        {rooms.map((room) => {
          const inDrill = room.optedOutAt === null;
          const course = `${room.courseCode} — ${room.courseName}`;
          return (
            <SettingRow
              key={room.classroomId}
              title={room.classroomName}
              desc={
                inDrill
                  ? course
                  : `${course} · ${t("drill.rooms.left", isoDateParts(room.optedOutAt!))}`
              }
            >
              <Switch
                checked={inDrill}
                disabled={change.isPending}
                label={t("drill.rooms.switch", { name: room.classroomName })}
                onChange={(next) => void toggle(room, next)}
              />
            </SettingRow>
          );
        })}
      </Card>
      {/* ADR-041 §8: the tab says who sees the activity, where the switches are. */}
      <p className="flex gap-2 text-[13px] text-fg-muted">
        <Eye aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-faint" />
        <span>{t("drill.rooms.notice")}</span>
      </p>
    </section>
  );
}
