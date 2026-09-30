/**
 * The Drill tab of a classroom (ADR-041 §6, §8, #317 slice 4): each
 * student's activity, and the mastery per tag. A read view, so the page
 * header carries no primary action on this tab.
 *
 * The switch is a row of the classroom's Settings (D24): with the drill off,
 * the tab is an empty state whose one action opens them.
 */
import type { ClassroomDetail, DrillStudentActivity, DrillTagMastery } from "@quiz/contracts";
import { drillRecallRate, drillRecallTrend } from "@quiz/domain";
import { Dumbbell, Tag } from "lucide-react";
import { useState } from "react";

import { useI18n, useT } from "../i18n";
import {
  Button,
  Card,
  EmptyState,
  isoDateParts,
  percent,
  QueryError,
  SectionHeading,
  SegmentedBar,
  Sheet,
  Skeleton,
  Stat,
} from "../ui";
import { useClassroomDrillActivity, useClassroomDrillMastery, useDrillProgress } from "./api";
import { DrillActivityTable, studentName, TrendMark } from "./DrillActivityTable";
import { WeeklyProgress } from "./WeeklyProgress";

const hasActivity = (rows: DrillStudentActivity[]) => rows.some((r) => r.reviews.all > 0 || r.optedOutAt !== null);

export function ClassroomDrill({
  room,
  onSettings,
}: {
  room: ClassroomDetail;
  /** Opens the classroom's Settings, where the switch is. */
  onSettings?: () => void;
}) {
  const t = useT();
  const activity = useClassroomDrillActivity(room.id);
  const [open, setOpen] = useState<DrillStudentActivity | null>(null);

  let body;
  if (activity.isLoading) {
    body = (
      <Card className="space-y-3 p-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </Card>
    );
  } else if (activity.isError || !activity.data) {
    body = (
      <QueryError
        title={t("drill.teacher.loadFailed")}
        error={activity.error}
        onRetry={() => void activity.refetch()}
        retrying={activity.isFetching}
        fallback={t("error.server")}
      />
    );
  } else if (!hasActivity(activity.data)) {
    // Off with no history, or on with nothing yet: one sentence, and, when
    // off, the way to the switch is the one thing to do.
    body = (
      <Card>
        {room.drillEnabled ? (
          <EmptyState icon={Dumbbell} title={t("drill.teacher.none.title")}>
            {t("drill.teacher.none.body")}
          </EmptyState>
        ) : (
          <EmptyState
            icon={Dumbbell}
            title={t("drill.teacher.off.title")}
            action={
              onSettings ? (
                <Button variant="secondary" onClick={onSettings}>
                  {t("drill.teacher.openSettings")}
                </Button>
              ) : undefined
            }
          >
            {t("drill.teacher.off.body")}
          </EmptyState>
        )}
      </Card>
    );
  } else {
    body = (
      <>
        <section className="space-y-2">
          <Card>
            <DrillActivityTable rows={activity.data} onOpen={setOpen} />
          </Card>
          <p className="px-1 text-xs text-fg-faint">{t("drill.recall.help")}</p>
          <p className="px-1 text-xs text-fg-faint">{t("drill.teacher.notice")}</p>
        </section>
        <MasteryPerTag classroomId={room.id} />
      </>
    );
  }

  return (
    <div className="space-y-8">
      {body}
      {open ? <DrillStudentSheet classroomId={room.id} row={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/** Mastery per tag: one bar per tag, the mean retrievability of the classroom's reviewed cards. */
function MasteryPerTag({ classroomId }: { classroomId: string }) {
  const t = useT();
  const { locale } = useI18n();
  const mastery = useClassroomDrillMastery(classroomId);
  if (mastery.isLoading) return <Skeleton className="h-40 w-full" />;
  if (mastery.isError || !mastery.data) {
    return (
      <QueryError
        title={t("drill.mastery.loadFailed")}
        error={mastery.error}
        onRetry={() => void mastery.refetch()}
        retrying={mastery.isFetching}
        fallback={t("error.server")}
      />
    );
  }
  // Nothing reviewed yet: the activity above already says so.
  if (mastery.data.length === 0) return null;
  return (
    <section className="space-y-3">
      <SectionHeading icon={Tag} title={t("drill.mastery.title")} description={t("drill.mastery.desc")} />
      <Card className="divide-y divide-line">
        {mastery.data.map((m: DrillTagMastery) => (
          <div key={m.tag ?? ""} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <p className={m.tag === null ? "truncate text-sm italic text-fg-muted" : "truncate text-sm font-semibold"}>
                {m.tag ?? t("drill.mastery.untagged")}
              </p>
              <p className="text-xs text-fg-faint">{t("drill.mastery.counts", { cards: m.cards, students: m.students })}</p>
            </div>
            {/* A share with no verdict (`info`): the figure beside it is the reading. */}
            <div className="order-last col-span-2 sm:order-none sm:col-span-1">
              <SegmentedBar parts={[{ tone: "info", value: m.retrievability }]} total={1} />
            </div>
            <p className="text-right text-sm font-semibold tabular-nums">{percent(m.retrievability, locale)}</p>
          </div>
        ))}
      </Card>
    </section>
  );
}

/** One student's drill: the figures, the opt-out, and the weekly progression. */
function DrillStudentSheet({
  classroomId,
  row,
  onClose,
}: {
  classroomId: string;
  row: DrillStudentActivity;
  onClose: () => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const progress = useDrillProgress(classroomId, row.enrollmentId);
  const rate = drillRecallRate(row.recall.all);
  return (
    <Sheet
      title={studentName(row)}
      subtitle={row.optedOutAt ? t("drill.student.optedOut", { date: isoDateParts(row.optedOutAt).date }) : undefined}
      onClose={onClose}
    >
      <div className="space-y-8">
        <div className="grid grid-cols-2 gap-3">
          <Stat label={t("drill.stat.questions")} value={row.questionsSeen} />
          <Stat label={t("drill.stat.sessions")} value={row.sessions} />
          <Stat label={t("drill.stat.reviews")} value={row.reviews.all} />
          <Stat
            label={t("drill.stat.recallAll")}
            value={
              <span className="inline-flex items-center gap-2">
                {rate === null ? "—" : percent(rate, locale)}
                <TrendMark trend={drillRecallTrend(row.recall.last30, row.recall.previous30)} />
              </span>
            }
            hint={rate === null ? undefined : t("drill.stat.recall.hint", { n: row.recall.all.repeated })}
          />
        </div>
        {progress.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : progress.isError || !progress.data ? (
          <QueryError
            title={t("drill.progressFailed")}
            error={progress.error}
            onRetry={() => void progress.refetch()}
            retrying={progress.isFetching}
            fallback={t("error.server")}
          />
        ) : (
          <WeeklyProgress weeks={progress.data.weeks} />
        )}
        <p className="text-xs text-fg-faint">{t("drill.recall.help")}</p>
      </div>
    </Sheet>
  );
}
