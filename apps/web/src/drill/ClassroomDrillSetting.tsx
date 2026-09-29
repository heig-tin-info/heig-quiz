/**
 * The drill switch of a classroom (ADR-041 §6): the teacher turns it on, its
 * students are then in by default and may opt out. Turning it on creates the
 * cards of the past evaluations that allow the drill (ADR-041 §13, item 1),
 * and the row says how many, so the teacher knows what the students got.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { ClassroomDetail } from "@quiz/contracts";

import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { classroomKey } from "../queryKeys";
import { Card, SettingRow, Switch } from "../ui";
import { setClassroomDrill } from "./api";

export function ClassroomDrillSetting({ room }: { room: ClassroomDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  // What the last enabling created, kept on the row: a toast fades, the
  // number is what the teacher came back to check.
  const [created, setCreated] = useState<number | null>(null);

  const change = useMutation({
    mutationFn: (enabled: boolean) => setClassroomDrill(room.id, enabled),
    onSuccess: async (settings) => {
      setCreated(settings.enabled ? settings.cardsCreated : null);
      await qc.invalidateQueries({ queryKey: classroomKey(room.id) });
      toast(
        settings.enabled
          ? t("classroom.drill.on", { n: settings.cardsCreated })
          : t("classroom.drill.off"),
        "success",
      );
    },
    onError: toastError("classroom.drill.failed"),
  });

  return (
    <Card className="px-4">
      <SettingRow
        title={t("classroom.drill")}
        desc={
          <>
            {t("classroom.drill.desc")}
            {room.drillEnabled && created !== null ? (
              <span className="mt-1 block font-medium text-fg">
                {t("classroom.drill.created", { n: created })}
              </span>
            ) : null}
          </>
        }
      >
        <Switch
          checked={room.drillEnabled}
          disabled={change.isPending}
          label={t("classroom.drill")}
          onChange={(enabled) => change.mutate(enabled)}
        />
      </SettingRow>
    </Card>
  );
}
