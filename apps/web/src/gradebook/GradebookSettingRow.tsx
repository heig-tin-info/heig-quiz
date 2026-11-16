/**
 * An activity's Gradebook row (ADR-131 §13, §14): its column's settings in
 * the mean, set from the activity's own settings — an exam's or an
 * exercise's configuration, a graded project's draft form and Settings tab —
 * from the draft on, so the weight is decided before the activity reaches
 * the students. The caller decides whether the activity has a column (never
 * a poll, a project not graded or archived); the row needs only its address.
 *
 * It reads `GET …/gradebook/columns/:kind/:activityId` and says the settings
 * in words: "In the mean · weight 40 %", a component's name in place of "In
 * the mean" on a course with components, "Out of the mean", or the warning
 * of a counted column in no component, icon and words. "Edit" opens the
 * matrix's own dialog (`ColumnDialog`), and the write is the matrix's
 * (`useStaffWrites`): the same refusals in words, the same question before
 * a change that moves a published mean. Not under the evaluation's
 * configuration lock (ADR-131 §13): the row stays live after the release.
 * On an archived classroom it is text only. A settings row: no accent.
 */
import { TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { GradebookColumnSettings } from "@quiz/contracts";
import { countsInMean } from "@quiz/domain";

import { useClassroom } from "../course/parts";
import { useT, type TFunction } from "../i18n";
import { Button, SettingRow, Skeleton } from "../ui";
import { useColumnSettings, type ColumnRef } from "./api";
import { ColumnDialog } from "./dialogs";
import { useStaffWrites } from "./useStaffWrites";

/** Where the column counts and its weight, in words. */
function summary(settings: GradebookColumnSettings, t: TFunction): ReactNode {
  if (!settings.counts) return t("gbook.settings.out");
  const hasComponents = settings.components.length > 0;
  if (!countsInMean(settings.counts, settings.componentId, hasComponents)) {
    return (
      <span className="flex items-start gap-1.5">
        <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
        {t("gbook.noComponent.help")}
      </span>
    );
  }
  const place = hasComponents
    ? (settings.components.find((c) => c.id === settings.componentId)?.name ?? "")
    : t("gbook.settings.in");
  return t("gbook.row.summary", { place, weight: String(settings.weight) });
}

export function GradebookSettingRow({
  classroomId,
  kind,
  activityId,
  title,
}: ColumnRef & {
  classroomId: string;
  /** The activity's title: the dialog's, and the question's before a published mean moves. */
  title: string;
}) {
  const t = useT();
  const read = useColumnSettings(classroomId, { kind, activityId });
  const archived = useClassroom(classroomId).data?.archivedAt != null;
  const { writes, patchColumn } = useStaffWrites(classroomId);
  const [editing, setEditing] = useState(false);
  const label = t("gbook.row");

  if (read.isPending) {
    return (
      <SettingRow title={label}>
        <span role="status" aria-label={t("common.loading")}>
          <Skeleton className="h-7 w-24" />
        </span>
      </SettingRow>
    );
  }
  if (read.isError) {
    return (
      <SettingRow title={label} desc={t("gbook.row.loadError")}>
        <Button variant="secondary" size="sm" loading={read.isFetching} onClick={() => void read.refetch()}>
          {t("common.retry")}
        </Button>
      </SettingRow>
    );
  }

  const settings = read.data;
  return (
    <SettingRow title={label} desc={summary(settings, t)}>
      {archived ? null : (
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          {t("common.edit")}
        </Button>
      )}
      {editing ? (
        <ColumnDialog
          title={title}
          value={settings}
          components={settings.components}
          submitting={writes.pending}
          onClose={() => setEditing(false)}
          onSubmit={async (patch) => {
            const done =
              patch === null ||
              (await patchColumn({ kind, activityId, title, ...settings }, patch, {
                meanPublished: settings.meanPublished,
                hasComponents: settings.components.length > 0,
              }));
            if (done) setEditing(false);
          }}
        />
      ) : null}
    </SettingRow>
  );
}
