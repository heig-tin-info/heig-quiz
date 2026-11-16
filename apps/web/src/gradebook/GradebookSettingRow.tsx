/**
 * The Gradebook row (ADR-131 §13, §14, §15): a column's settings in the
 * mean, set from the activity's own settings — an exam's or an exercise's
 * configuration, a graded project's draft form and Settings tab — from the
 * draft on, so the weight is decided before the activity reaches the
 * students; or from an evaluation template's settings, which every
 * evaluation made from it starts with (the Settings tab's heading says so,
 * once for every row of it). The caller decides
 * whether there is a column (never a poll, a project not graded or
 * archived); the row needs only its address (`ColumnHome`).
 *
 * It reads the column's settings and says them in words: "In the mean · weight 40 %", a component's name in place of "In
 * the mean" on a course with components, "Out of the mean", or the warning
 * of a counted column in no component, icon and words. "Edit" opens the
 * matrix's own dialog (`ColumnDialog`). An activity's write is the
 * matrix's (`useStaffWrites`): the same refusals in words, the same question
 * before a change that moves a published mean. Not under the evaluation's
 * configuration lock (ADR-131 §13): the row stays live after the release.
 * On an archived classroom, or before the classroom is read, it is text
 * only. A template's write is its own route's, refused in the same words; a
 * template has no classroom to archive and no mean to move, so it asks
 * nothing. A settings row: no accent.
 */
import { TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { GradebookColumnPatch, GradebookColumnSettings } from "@quiz/contracts";
import { countsInMean } from "@quiz/domain";

import { useClassroom } from "../course/parts";
import { useT, type TFunction } from "../i18n";
import { Button, SettingRow, Skeleton } from "../ui";
import { useColumnSettings, useTemplateColumnWrite, type ColumnHome } from "./api";
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
  home,
  title,
}: {
  home: ColumnHome;
  /** The activity's or the template's title: the dialog's, and the question's before a published mean moves. */
  title: string;
}) {
  const t = useT();
  const read = useColumnSettings(home);
  const classroomId = "classroomId" in home ? home.classroomId : null;
  // An activity's Edit only once its classroom is known and live: never a flash on an archived one, nor a button its read failed to clear.
  const room = useClassroom(classroomId);
  const editable = classroomId === null || (room.data !== undefined && room.data.archivedAt === null);
  // Both writers exist, one is used: an activity's (its classroom's) or a template's.
  const staff = useStaffWrites(classroomId ?? "");
  const template = useTemplateColumnWrite("templateId" in home ? home.templateId : "");
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
  const write = (patch: GradebookColumnPatch): Promise<boolean> =>
    "templateId" in home
      ? staff.attempt(() => template.patch(patch))
      : staff.patchColumn(
          { ...home, title, released: settings.released, counts: settings.counts, componentId: settings.componentId },
          patch,
          { meanPublished: settings.meanPublished, hasComponents: settings.components.length > 0 },
        );
  return (
    <SettingRow title={label} desc={summary(settings, t)}>
      {editable ? (
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          {t("common.edit")}
        </Button>
      ) : null}
      {editing ? (
        <ColumnDialog
          title={title}
          value={settings}
          components={settings.components}
          submitting={staff.writes.pending || template.pending}
          onClose={() => setEditing(false)}
          onSubmit={async (patch) => {
            if (patch === null || (await write(patch))) setEditing(false);
          }}
        />
      ) : null}
    </SettingRow>
  );
}
