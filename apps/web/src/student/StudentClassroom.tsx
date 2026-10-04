/**
 * The student's page of one classroom (F-ORG-15, `docs/merge/05-web.md` §5.2):
 * everything about that course, where the home keeps "what do I do now"
 * across all of them. A student, a teacher in the student view (ADR-018) and
 * an impersonation session (ADR-034) read the same student payload.
 *
 * Its tabs are routes: Activities (`/classrooms/:id`) and, when the
 * classroom has one, Journal (`/classrooms/:id/journal/<path>`), which is the
 * M4-04 reader under this page's compact header (in every build since
 * M4-05; `hasJournal` is false on a platform without Quiz's App, so no tab
 * there); the grades stay an anchor of the home until M5-04.
 *
 * The four decisions:
 *   - Type: the classroom's name at the page-title step; the activity titles
 *     at 17 px; the course, the period and the teachers 13–14 px. On the
 *     Journal tab the document owns the title, so the header folds to a
 *     13 px breadcrumb.
 *   - Color: ONE accent, the button of the single most urgent open activity
 *     (`mostUrgent`); every other button is secondary. The time bonus is a
 *     soft badge, as on the home card.
 *   - Space: 24 between the header, the tabs and the body; 32 between the
 *     groups; 12 between the cards of a group.
 *   - Finish: cards on the canvas, hairlines, no shadow.
 */
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, School } from "lucide-react";
import { useEffect } from "react";

import type { StudentActivities, StudentActivityCard, StudentClassroomPage } from "@quiz/contracts";

import { api, ApiError } from "../api";
import { useT } from "../i18n";
import { JournalReader } from "../journal/JournalReader";
import { studentClassroomKey } from "../queryKeys";
import { useServerClock } from "../realtime/useServerClock";
import type { Navigate } from "../router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageError,
  PageHeader,
  ParentLink,
  SectionHeading,
  Skeleton,
  Tabs,
  useNow,
} from "../ui";
import {
  ActivityCard,
  BonusBadge,
  finished,
  PollRow,
  UpcomingByDay,
  useCardActions,
} from "./cards";
import { needsStudentAction } from "./projectRow";

export type ClassroomTab = "activities" | "journal";

type Header = StudentClassroomPage["classroom"];

/** What an open card is due by: an attempt's deadline, else the evaluation's closing; a project's deadline. */
function dueAt(card: StudentActivityCard): string | null {
  return card.kind === "project" ? card.deadlineAt : (card.deadlineAt ?? card.closesAt);
}

/**
 * The single most urgent open activity, the one whose button is the page's
 * primary (F-ORG-15), by rank then by due time:
 *   0. a card still to do that has a deadline (the attempt's, else the
 *      evaluation's closing; a project's deadline), the soonest first — a
 *      grade is at stake;
 *   1. a running poll — it happens in the room, now, and lasts minutes;
 *   2. a card still to do with no deadline;
 *   3. a card already done and open to a retake.
 * A project whose repository is ready asks nothing of the student and is
 * not ranked at all (M3-13): its "Open repository" never takes the accent.
 * Ties keep the server's order. `null` when nothing is open.
 */
export function mostUrgent({ polls, open }: Pick<StudentActivities, "polls" | "open">, now = Date.now()): string | null {
  const ranked = [
    ...open
      .filter((card) => card.kind !== "project" || needsStudentAction(card, now))
      .map((card) => {
        const due = dueAt(card);
        const rank = card.kind === "evaluation" && finished(card) ? 3 : due === null ? 2 : 0;
        return { id: card.id, rank, due: due === null ? 0 : Date.parse(due) };
      }),
    ...polls.map((poll) => ({ id: poll.id, rank: 1, due: 0 })),
  ];
  // `Array.prototype.sort` is stable: ties keep the server's order.
  ranked.sort((a, b) => a.rank - b.rank || a.due - b.due);
  return ranked[0]?.id ?? null;
}

const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

export function StudentClassroom({
  id,
  tab,
  path,
  navigate,
}: {
  id: string;
  tab: ClassroomTab;
  /** The journal page the address names (the Journal tab only). */
  path?: string | undefined;
  navigate: Navigate;
}) {
  const t = useT();
  const page = useQuery<StudentClassroomPage>({
    queryKey: studentClassroomKey(id),
    queryFn: () => api(`/app/api/student/classrooms/${id}`),
  });
  const toCourses = () => navigate({ view: "studentCourses" });
  // The Journal's address on a classroom that has none (removed meanwhile,
  // or no App on the platform): the classroom's page, in place.
  const noJournal = tab === "journal" && page.data !== undefined && !page.data.hasJournal;
  useEffect(() => {
    if (noJournal) navigate({ view: "classroom", id }, { replace: true });
  }, [noJournal, navigate, id]);

  // A classroom the caller holds no seat in reads as one that does not exist.
  if (isNotFound(page.error)) {
    return (
      <EmptyState
        icon={School}
        titleAs="h1"
        title={t("classrooms.notFound")}
        action={
          <Button variant="secondary" onClick={toCourses}>
            {t("sroom.backToCourses")}
          </Button>
        }
      />
    );
  }
  if (page.isError) {
    return (
      <PageError
        title={t("sroom.loadError")}
        error={page.error}
        onRetry={() => void page.refetch()}
        retrying={page.isFetching}
      />
    );
  }

  const data = page.data;
  // The Journal tab: only when the classroom has one (F-JRN-07). Kept while
  // it is the tab being read.
  const tabs =
    data?.hasJournal || tab === "journal" ? (
      <Tabs<ClassroomTab>
        label={t("sroom.tabs")}
        value={tab}
        onChange={(next) =>
          navigate(next === "journal" ? { view: "classroomJournal", id } : { view: "classroom", id })
        }
        items={[
          { value: "activities", label: t("sroom.tab.activities") },
          { value: "journal", label: t("sroom.tab.journal") },
        ]}
      />
    ) : null;

  if (tab === "journal") {
    // The reader loads beside the header, and draws it in each of its states.
    return (
      <JournalReader
        classroomId={id}
        path={path}
        navigate={navigate}
        studentView
        header={
          <div className="space-y-4">
            {data ? <Breadcrumb room={data.classroom} onCourses={toCourses} /> : <Skeleton className="h-4 w-40" />}
            {tabs}
          </div>
        }
      />
    );
  }

  if (!data) {
    return (
      <div className="space-y-6" role="status" aria-label={t("common.loading")}>
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ClassroomHeader room={data.classroom} onCourses={toCourses} />
      {tabs}
      <Activities activities={data.activities} serverNow={data.serverNow} navigate={navigate} />
    </div>
  );
}

/** The page's header: the way back to Courses, the classroom, its course, period and teachers. */
function ClassroomHeader({ room, onCourses }: { room: Header; onCourses: () => void }) {
  const t = useT();
  return (
    <PageHeader
      eyebrow={<ParentLink onClick={onCourses}>{t("nav.courses")}</ParentLink>}
      title={
        <span className="flex flex-wrap items-baseline gap-3">
          {room.name}
          {room.archived ? <Badge tone="zinc">{t("classrooms.archived")}</Badge> : null}
        </span>
      }
      description={
        <>
          <p>
            {room.courseCode} — {room.courseName}
            {room.period ? ` · ${room.period}` : ""}
          </p>
          {room.teachers.length > 0 ? (
            <p className="mt-0.5 text-[13px] text-fg-faint">
              {t("shome.teachers", { names: room.teachers.join(", ") })}
            </p>
          ) : null}
        </>
      }
      actions={<BonusBadge percent={room.timeBonusPercent} />}
    />
  );
}

/** The Journal tab's compact header: the document below owns the page's title. */
function Breadcrumb({ room, onCourses }: { room: Header; onCourses: () => void }) {
  const t = useT();
  return (
    <nav aria-label={t("journal.breadcrumb")} className="flex items-center gap-1.5 text-[13px] text-fg-muted">
      <ParentLink onClick={onCourses}>{t("nav.courses")}</ParentLink>
      <ChevronRight className="size-3.5 text-fg-faint" aria-hidden />
      <span className="text-fg">{room.name}</span>
    </nav>
  );
}

/**
 * Open now, Upcoming (by day, as on the home), Past: the home's cards for
 * this classroom, one accent among them.
 */
function Activities({
  activities,
  serverNow,
  navigate,
}: {
  activities: StudentActivities;
  serverNow: string;
  navigate: Navigate;
}) {
  const t = useT();
  // The server's clock (invariant 5), sampled from the payload: the
  // countdowns, the start gate of a project and `mostUrgent` all read it.
  const clock = useServerClock();
  const { sample } = clock;
  useEffect(() => sample(serverNow), [sample, serverNow]);
  const now = useNow(30_000) + clock.offset;
  const actions = useCardActions(navigate);
  const { polls, open, upcoming, past } = activities;
  const urgent = mostUrgent(activities, now);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionHeading title={t("shome.open")} />
        {polls.length === 0 && open.length === 0 ? (
          <Card>
            <EmptyState icon={CheckCircle2} title={t("sroom.empty.title")}>
              {t("sroom.empty.body")}
            </EmptyState>
          </Card>
        ) : null}
        {polls.map((poll) => (
          <PollRow key={poll.id} poll={poll} navigate={navigate} primary={poll.id === urgent} showWhere={false} />
        ))}
        {open.map((card) => (
          <ActivityCard key={card.id} card={card} group="open" now={now} navigate={navigate} primary={card.id === urgent} showWhere={false} actions={actions} />
        ))}
      </section>

      {upcoming.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading title={t("shome.upcoming")} />
          <UpcomingByDay cards={upcoming} now={now} navigate={navigate} showWhere={false} />
        </section>
      ) : null}

      {past.length > 0 ? (
        <section className="space-y-3">
          <SectionHeading title={t("shome.past")} />
          {past.map((card) => (
            <ActivityCard key={card.id} card={card} group="past" now={now} navigate={navigate} showWhere={false} actions={actions} />
          ))}
        </section>
      ) : null}

      {actions.modal}
    </div>
  );
}
