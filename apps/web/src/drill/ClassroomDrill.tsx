/**
 * The Drill tab of a classroom (ADR-041 §6, §8, #317 slice 4): each
 * student's activity, the hours of the week they practise at, who revised
 * which concept on purpose (ADR-115 §9: counts and dates, never a card or a
 * question), the mastery per concept, and the confidence per question
 * (ADR-085 §8, aggregated only). The rounds are read once, here, for the
 * table, the section and the sheet: a second observer mounting under a
 * failed read would fetch it again and blank the tab. A read view, so the page
 * header carries no primary action on this tab.
 *
 * The switch is a row of the classroom's Settings (D24): with the drill off,
 * the tab is an empty state whose one action opens them.
 */
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  ClassroomDetail,
  DrillClassroomRevision,
  DrillConceptMastery,
  DrillStudentActivity,
} from "@quiz/contracts";

import { refName } from "../concepts/names";
import { drillRecallRate, drillRecallTrend } from "@quiz/domain";
import { Dumbbell, Tag, Target } from "lucide-react";
import { useMemo, useState } from "react";

import { useI18n, useT, type TFunction } from "../i18n";
import {
  Badge,
  Button,
  Card,
  Disclosure,
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
import { useClassroomDrillActivity, useClassroomDrillMastery, useClassroomDrillRevision, useDrillProgress } from "./api";
import { ConfidencePerQuestion } from "./Confidence";
import { ClassroomDrillHours, StudentDrillHours } from "./DrillHours";
import { DrillActivityTable, studentName, TrendMark, type StudentRevision } from "./DrillActivityTable";
import { WeeklyProgress } from "./WeeklyProgress";

/** Anything to show: a review, an opt-out, or a round of targeted revision. */
const hasActivity = (rows: DrillStudentActivity[], revision: ReadonlyMap<string, StudentRevision> | null) =>
  (revision?.size ?? 0) > 0 || rows.some((r) => r.reviews.all > 0 || r.optedOutAt !== null);

export function ClassroomDrill({
  room,
  onSettings,
}: {
  room: ClassroomDetail;
  /** Opens the classroom's Settings, where the switch is. */
  onSettings: () => void;
}) {
  const t = useT();
  const activity = useClassroomDrillActivity(room.id);
  // A failed read of the rounds leaves the activity standing: its own section
  // says so, and the column and the sheet's block, null here, are not drawn.
  const revision = useClassroomDrillRevision(room.id);
  const rounds = useMemo(
    () => (revision.data ? new Map(revision.data.students.map((s) => [s.enrollmentId, s] as const)) : null),
    [revision.data],
  );
  const [open, setOpen] = useState<DrillStudentActivity | null>(null);

  let body;
  if (activity.isLoading || revision.isLoading) {
    body = (
      <Card className="space-y-3 p-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </Card>
    );
  } else if (activity.isError || !activity.data) {
    body = (
      <QueryError title={t("drill.teacher.loadFailed")} query={activity} />
    );
  } else if (!hasActivity(activity.data, rounds)) {
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
              <Button variant="secondary" onClick={onSettings}>
                {t("drill.teacher.openSettings")}
              </Button>
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
            <DrillActivityTable rows={activity.data} revision={rounds} onOpen={setOpen} />
          </Card>
          <p className="px-1 text-xs text-fg-faint">{t("drill.recall.help")}</p>
          <p className="px-1 text-xs text-fg-faint">{t("drill.teacher.notice")}</p>
        </section>
        <ClassroomDrillHours classroomId={room.id} />
        <RevisionPerConcept revision={revision} />
        <MasteryPerConcept classroomId={room.id} />
        <ConfidencePerQuestion classroomId={room.id} />
      </>
    );
  }

  return (
    <div className="space-y-8">
      {body}
      {open ? (
        <DrillStudentSheet
          classroomId={room.id}
          row={open}
          rounds={rounds}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Who revised which concept before the test (ADR-115 §9): per concept, the
 * students, the rounds and the last one, as the server counts them. A read
 * of counts: never a card, a question or an answer.
 */
function RevisionPerConcept({ revision }: { revision: UseQueryResult<DrillClassroomRevision> }) {
  const t = useT();
  if (revision.isError || !revision.data) {
    return <QueryError title={t("drill.revision.loadFailed")} query={revision} />;
  }
  const { concepts } = revision.data;
  return (
    <section className="space-y-3">
      <SectionHeading icon={Target} title={t("drill.revision.title")} description={t("drill.revision.desc")} />
      {concepts.length === 0 ? (
        <p className="px-1 text-sm text-fg-muted">{t("drill.revision.none")}</p>
      ) : (
        <Card className="divide-y divide-line">
          {concepts.map((c) => (
            <div key={c.concept.id} className="flex items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{refName(c.concept)}</p>
                <p className="text-xs text-fg-faint">
                  {plural(t, "students", c.students)} · {plural(t, "rounds", c.rounds)}
                </p>
              </div>
              <p className="shrink-0 text-xs text-fg-muted">
                {t("drill.revision.last", { date: isoDateParts(c.lastAt).date })}
              </p>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}

/** "1 round", "3 rounds": a key and its `.one`, written whole so the unused-key check sees both. */
const PLURAL = {
  rounds: ["drill.revision.rounds.one", "drill.revision.rounds"],
  students: ["drill.revision.students.one", "drill.revision.students"],
} as const;
const plural = (t: TFunction, what: keyof typeof PLURAL, n: number) => t(PLURAL[what][n === 1 ? 0 : 1], { n });

/** One student's rounds in their sheet: how many, the score of their first passes, the last day, the concepts. */
function StudentRevisionBlock({ revision }: { revision: StudentRevision | undefined }) {
  const t = useT();
  return (
    <section className="space-y-2">
      <p className="text-sm font-semibold">{t("drill.revision.title")}</p>
      {revision ? (
        <>
          <p className="text-sm text-fg-muted">
            {plural(t, "rounds", revision.rounds)} ·{" "}
            {t("drill.revision.score", { right: revision.cardsCorrect, total: revision.cardsServed })} ·{" "}
            {t("drill.revision.last", { date: isoDateParts(revision.lastAt).date })}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {revision.concepts.map((c) => (
              <Badge key={c.id} tone="zinc">
                {refName(c)}
              </Badge>
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-fg-muted">{t("drill.revision.none")}</p>
      )}
    </section>
  );
}

/**
 * Mastery on the course's concepts (#599 step 9a): one line per concept the
 * course lists, the reviewed cards counted toward it (a card counts on every
 * listed concept that covers one of its own), a line without evidence apart
 * from a low mastery, and what the list does not cover in a folded bucket.
 * A course listing no concept gets the flat per-concept view and the hint to
 * declare them (ADR-081 sixth addendum).
 */
function MasteryPerConcept({ classroomId }: { classroomId: string }) {
  const t = useT();
  const mastery = useClassroomDrillMastery(classroomId);
  if (mastery.isLoading) return <Skeleton className="h-40 w-full" />;
  if (mastery.isError || !mastery.data) {
    return (
      <QueryError title={t("drill.mastery.loadFailed")} query={mastery} />
    );
  }
  const { declared, concepts, outside } = mastery.data;
  // Nothing reviewed and nothing declared: the activity above already says so.
  if (concepts.length === 0 && !declared) return null;
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Tag}
        title={declared ? t("drill.mastery.course.title") : t("drill.mastery.title")}
        description={declared ? t("drill.mastery.course.desc") : t("drill.mastery.desc")}
      />
      {declared ? null : <p className="px-1 text-xs text-fg-faint">{t("drill.mastery.declareHint")}</p>}
      <Card className="divide-y divide-line">
        {concepts.map((m) => (
          <MasteryRow key={m.concept?.id ?? ""} m={m} />
        ))}
      </Card>
      {outside ? (
        <Disclosure
          title={t("drill.mastery.outside")}
          desc={t("drill.mastery.outside.desc")}
          aside={<span className="text-xs font-normal text-fg-faint">{t("drill.mastery.outside.count", { cards: outside.cards })}</span>}
        >
          {outside.concepts.map((m) => (
            <MasteryRow key={m.concept?.id ?? ""} m={m} />
          ))}
        </Disclosure>
      ) : null}
    </section>
  );
}

/** One concept: its name and counts, its bar and figure — or, without a card, a plain "no evidence". */
function MasteryRow({ m }: { m: DrillConceptMastery }) {
  const t = useT();
  const { locale } = useI18n();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className={m.concept === null ? "truncate text-sm italic text-fg-muted" : "truncate text-sm font-semibold"}>
          {m.concept === null ? t("drill.mastery.noConcept") : refName(m.concept)}
        </p>
        {m.retrievability === null ? null : (
          <p className="text-xs text-fg-faint">{t("drill.mastery.counts", { cards: m.cards, students: m.students })}</p>
        )}
      </div>
      {m.retrievability === null ? (
        <p className="col-span-1 text-right text-xs italic text-fg-faint sm:col-span-2">{t("drill.mastery.noEvidence")}</p>
      ) : (
        <>
          {/* A share with no verdict (`info`): the figure beside it is the reading. */}
          <div className="order-last col-span-2 sm:order-none sm:col-span-1">
            <SegmentedBar parts={[{ tone: "info", value: m.retrievability }]} total={1} />
          </div>
          <p className="text-right text-sm font-semibold tabular-nums">{percent(m.retrievability, locale)}</p>
        </>
      )}
    </div>
  );
}

/** One student's drill: the figures, the opt-out, the weekly progression, the hours of the week and the targeted revision. */
function DrillStudentSheet({
  classroomId,
  row,
  rounds,
  onClose,
}: {
  classroomId: string;
  row: DrillStudentActivity;
  /** Every student's rounds; null when they could not be read. */
  rounds: ReadonlyMap<string, StudentRevision> | null;
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
          <QueryError title={t("drill.progressFailed")} query={progress} />
        ) : (
          <WeeklyProgress weeks={progress.data.weeks} />
        )}
        <StudentDrillHours classroomId={classroomId} enrollmentId={row.enrollmentId} />
        {rounds ? <StudentRevisionBlock revision={rounds.get(row.enrollmentId)} /> : null}
        <p className="text-xs text-fg-faint">{t("drill.recall.help")}</p>
      </div>
    </Sheet>
  );
}
