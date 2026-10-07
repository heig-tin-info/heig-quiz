/**
 * The cards the student's pages share: the activity rows (an evaluation, a
 * running poll, a project), their one-line captions, and the list of
 * classrooms. The home (`StudentHome`) lists them across every classroom, the
 * classroom page (`StudentClassroom`) for one, the Courses page
 * (`StudentCourses`) the classrooms (F-ORG-14, F-ORG-15).
 *
 * A row decides nothing about emphasis: the page says which button is the
 * primary, since the home lights every open card and the classroom page only
 * its most urgent one. The row itself is `ActivityRow.tsx`; a project's row
 * and its four-state button are `ProjectRow.tsx` (M3-13).
 */
import { useQuery } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import {
  Award,
  CalendarClock,
  ChartNoAxesColumn,
  Clock,
  FileCheck2,
  GraduationCap,
  History,
  Hourglass,
  Monitor,
  PencilLine,
  Presentation,
  Repeat,
  School,
  Timer,
  Users,
} from "lucide-react";

import { formatPoints, groupByDay, type DayBucket, type StudentActivityGroup } from "@quiz/domain";
import type {
  EvaluationCard as EvaluationCardData,
  StudentActivityCard,
  StudentClassroom,
  StudentGroupSetCard,
  StudentPollCard,
} from "@quiz/contracts";

import { api } from "../api";
import { feedbackLink } from "../grading";
import { formatDuration, useT, type TFunction } from "../i18n";
import { studentClassroomsKey } from "../queryKeys";
import { routeToPath, type Navigate, type Route } from "../router";
import {
  Badge,
  Card,
  cx,
  EmptyState,
  isoDateParts,
  isoDateTime,
  localTimeZone,
  MetaItem,
  pressable,
  QueryError,
  Skeleton,
  type IconType,
} from "../ui";
import { ActivityRow, leftLine, startsLine, type RowAction, type RowStatus } from "./ActivityRow";
import { ProjectRow } from "./ProjectRow";
import { useRetake } from "./retake";
import { SebLaunchModal } from "./SebLaunchModal";

export { ActivityRow, leftLine, startsLine, type RowAction } from "./ActivityRow";

/** The icon of a kind of evaluation, the first thing on its card (named by a `Tip`). */
const MODE_ICON = {
  exam: FileCheck2,
  exercise: PencilLine,
  poll: ChartNoAxesColumn,
} as const satisfies Record<keyof typeof MODE_KEY, IconType>;

export const MODE_KEY = {
  exam: "shome.mode.exam",
  exercise: "shome.mode.exercise",
  poll: "shome.mode.poll",
} as const;

/** What the single button on an open card says, and where it goes. */
function primaryAction(card: EvaluationCardData, t: TFunction): string {
  if (card.attemptState === "in_progress") return t("shome.resume");
  if (card.state === "lobby") return t("shome.lobby");
  return t("shome.start");
}

/**
 * Issue #126: when the attempt being resumed was started, so a student with
 * retakes (F-EVAL-15), or an exercise left open for days, knows which one
 * "Continue" opens. Before the time left: it names the attempt, the time
 * left is about the evaluation.
 */
function timingMeta(card: EvaluationCardData, now: number, t: TFunction): ReactNode {
  return (
    <>
      {card.attemptState === "in_progress" && card.attemptStartedAt !== null ? (
        <MetaItem icon={History}>{t("shome.startedAt", isoDateParts(card.attemptStartedAt))}</MetaItem>
      ) : null}
      {timeLeftMeta(card, now, t)}
    </>
  );
}

function timeLeftMeta(card: EvaluationCardData, now: number, t: TFunction): ReactNode {
  // The attempt's own deadline while it is ahead; the evaluation's closing otherwise.
  if (card.deadlineAt !== null && Date.parse(card.deadlineAt) > now) return <MetaItem icon={Clock}>{leftLine(card.deadlineAt, now, t)}</MetaItem>;
  if (card.closesAt !== null) return <MetaItem icon={Clock}>{leftLine(card.closesAt, now, t)}</MetaItem>;
  if (card.durationS !== null) return <MetaItem icon={Timer}>{t("shome.duration", { n: Math.round(card.durationS / 60) })}</MetaItem>;
  return null;
}

/** A finished attempt: handed in, or closed by time or by the teacher. */
export const finished = (card: EvaluationCardData): boolean =>
  card.attemptState === "submitted" || card.attemptState === "expired";

/**
 * "n questions awaiting grading": the cells of an attempt with no validated
 * grading yet, which count nowhere. The same words wherever points are shown
 * beside them — the feedback page, the Grades page, this card.
 */
const pendingLabel = (n: number, t: TFunction): string =>
  t(n === 1 ? "feedback.pendingCount.one" : "feedback.pendingCount", { n });

/** {@link pendingLabel} as a muted line, under points; nothing at 0. */
export function PendingLine({ count, className }: { count: number; className?: string }) {
  const t = useT();
  if (count === 0) return null;
  return <span className={cx("block text-[13px] text-fg-muted", className)}>{pendingLabel(count, t)}</span>;
}

/**
 * F-EVAL-15: the facts of an exercise with retakes once an attempt is done —
 * the score that counts (best or last) and how many attempts were taken.
 * The score is all the student reads between two attempts (ADR-025).
 */
function retakeMeta(card: EvaluationCardData, t: TFunction): ReactNode {
  const r = card.retakes;
  if (r === null) return null;
  const score = r.kept?.score ?? null;
  return (
    <>
      {/* `score` is null once the exercise is closed and the feedback policy
          hides it (on release, none): the card says no more than the feedback page. */}
      {score !== null ? (
        <MetaItem icon={Award}>
          {t(r.keep === "best" ? "shome.kept.best" : "shome.kept.last", {
            points: formatPoints(score.points),
            total: formatPoints(score.totalPoints),
          })}
        </MetaItem>
      ) : null}
      <MetaItem icon={Repeat}>
        {r.maxAttempts === null
          ? t("shome.attempts", { n: r.attemptCount })
          : t("shome.attemptsOf", { n: r.attemptCount, max: r.maxAttempts })}
      </MetaItem>
      {score?.pendingCount ? <MetaItem icon={Hourglass}>{pendingLabel(score.pendingCount, t)}</MetaItem> : null}
    </>
  );
}

/** ADR-051 §2: an exam sat on a kiosk station and nowhere else. */
const kioskOnly = (card: EvaluationCardData): boolean =>
  card.trustedClients.includes("kiosk") && !card.trustedClients.includes("seb");

/**
 * The facts of an open card: where to sit it for a kiosk-only exam, the
 * retake count once done, the time left otherwise.
 */
export function openMeta(card: EvaluationCardData, now: number, t: TFunction): ReactNode {
  if (kioskOnly(card)) return <MetaItem icon={Monitor}>{t("shome.kiosk")}</MetaItem>;
  return card.retakes !== null && finished(card) ? retakeMeta(card, t) : timingMeta(card, now, t);
}

/**
 * The facts of a past card: the retake count, and, issue #203, that the
 * results are still to come when the server says so (`results: "pending"`)
 * — the card has no button for them then, so the student reads it here
 * instead of on an empty page. A score already shown (between two attempts)
 * needs no such note. How the attempt ended is the status badge's.
 */
export function pastMeta(card: EvaluationCardData, t: TFunction): ReactNode {
  const waiting = finished(card) && card.results === "pending" && !card.retakes?.kept?.score;
  return (
    <>
      {card.retakes !== null && card.attemptId !== null ? retakeMeta(card, t) : null}
      {waiting ? <MetaItem icon={Hourglass}>{t("shome.resultsPending")}</MetaItem> : null}
    </>
  );
}

export function upcomingMeta(card: EvaluationCardData, now: number, t: TFunction): ReactNode {
  return (
    <MetaItem icon={CalendarClock}>
      {card.opensAt === null ? t("shome.upcoming.empty") : startsLine(card.opensAt, now, t)}
    </MetaItem>
  );
}

/**
 * Where an evaluation stands, as its badge (the cards' one tone rule, see
 * `RowStatus`); none while it is only coming up.
 */
export function evaluationStatus(card: EvaluationCardData, group: StudentActivityGroup, t: TFunction): RowStatus | undefined {
  if (group === "upcoming") return undefined;
  if (card.attemptState === "submitted") return { label: t("shome.state.submitted"), tone: "green" };
  if (card.attemptState === "expired") return { label: t("shome.state.expired"), tone: "zinc" };
  if (group === "past") return { label: t("shome.state.notStarted"), tone: "zinc" };
  return card.attemptState === "in_progress"
    ? { label: t("shome.status.inProgress"), tone: "green" }
    : { label: t("shome.status.open"), tone: "amber" };
}

/** The instant a card's "coming up" line counts down to: an evaluation opens, a project starts. */
export const opensAt = (card: StudentActivityCard): string | null => (card.kind === "project" ? card.startAt : card.opensAt);

/**
 * One card of the student's Activities, whatever its kind (M3-09a): an
 * evaluation's row with the line and the button of its group, or a project's
 * row with its one action (`ProjectRow`, M3-13). `actions` are the page's
 * `useCardActions`; absent in Upcoming, which never has a button.
 */
export function ActivityCard({
  card,
  group,
  now,
  navigate,
  primary = false,
  showWhere = true,
  actions,
}: {
  card: StudentActivityCard;
  group: StudentActivityGroup;
  now: number;
  navigate: Navigate;
  primary?: boolean;
  showWhere?: boolean;
  actions?: Pick<ReturnType<typeof useCardActions>, "open" | "review"> | undefined;
}) {
  const t = useT();
  if (card.kind === "project") {
    return <ProjectRow card={card} group={group} now={now} navigate={navigate} primary={primary} showWhere={showWhere} />;
  }
  if (group === "open") {
    return <EvaluationRow card={card} group={group} meta={openMeta(card, now, t)} showWhere={showWhere} action={actions?.open(card, primary)} />;
  }
  if (group === "past") {
    return <EvaluationRow card={card} group={group} meta={pastMeta(card, t)} showWhere={showWhere} action={actions?.review(card)} />;
  }
  return <EvaluationRow card={card} group={group} meta={upcomingMeta(card, now, t)} showWhere={showWhere} />;
}

const DAY_KEY = {
  today: "shome.day.today",
  tomorrow: "shome.day.tomorrow",
  week: "shome.day.week",
  later: "shome.day.later",
} as const satisfies Record<DayBucket, string>;

/**
 * "Coming up" as an agenda (product owner, 2026-10-01): the cards under
 * Today, Tomorrow, This week and Later, by the day they OPEN (`opensAt`, the
 * instant their line counts down to: a scheduled evaluation's opening, a
 * project's start), in the browser's time zone (`groupByDay` of
 * `@quiz/domain`). The soonest first inside a day; an empty day is not
 * drawn. `now` is the page's `useNow`, so the cards move from Tomorrow to
 * Today at midnight. The sub-heading is the teacher's schedule's week
 * heading, one step down.
 */
export function UpcomingByDay({
  cards,
  now,
  navigate,
  showWhere = true,
}: {
  cards: readonly StudentActivityCard[];
  now: number;
  navigate: Navigate;
  showWhere?: boolean;
}) {
  return (
    <div className="space-y-5">
      {groupByDay(cards, opensAt, now, localTimeZone()).map(({ bucket, rows }) => (
        <DayGroup key={bucket} bucket={bucket} cards={rows} now={now} navigate={navigate} showWhere={showWhere} />
      ))}
    </div>
  );
}

/** One day of {@link UpcomingByDay}: its sub-heading, which names the list, and its cards. */
function DayGroup({
  bucket,
  cards,
  now,
  navigate,
  showWhere,
}: {
  bucket: DayBucket;
  cards: readonly StudentActivityCard[];
  now: number;
  navigate: Navigate;
  showWhere: boolean;
}) {
  const t = useT();
  const id = useId();
  return (
    <div className="space-y-2">
      <h3 id={id} className={cx("text-sm font-semibold", bucket === "today" ? "text-fg" : "text-fg-muted")}>
        {t(DAY_KEY[bucket])}
      </h3>
      <ul className="space-y-3" aria-labelledby={id}>
        {cards.map((card) => (
          <li key={card.id}>
            <ActivityCard card={card} group="upcoming" now={now} navigate={navigate} showWhere={showWhere} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** `showWhere` is false on the classroom's own page, where every row is of that classroom. */
export function EvaluationRow({
  card,
  group,
  meta,
  action,
  showWhere = true,
}: {
  card: EvaluationCardData;
  group: StudentActivityGroup;
  meta: ReactNode;
  action?: RowAction | undefined;
  showWhere?: boolean;
}) {
  const t = useT();
  return (
    <ActivityRow
      kind={{ label: t(MODE_KEY[card.mode]), icon: MODE_ICON[card.mode] }}
      title={card.title}
      where={showWhere ? `${card.courseCode} · ${card.classroomName}` : undefined}
      status={evaluationStatus(card, group, t)}
      meta={meta}
      action={action}
    />
  );
}

/**
 * A running poll of one of the student's classrooms (issue #163), answered on
 * the poll's own page, `/p/:code`, never in the player. It has no title of its
 * own: the server sends none, because a poll's title is its question
 * (invariant 4).
 */
export function PollRow({
  poll,
  navigate,
  primary = true,
  showWhere = true,
}: {
  poll: StudentPollCard;
  navigate: (r: Route) => void;
  primary?: boolean;
  showWhere?: boolean;
}) {
  const t = useT();
  return (
    <ActivityRow
      kind={{ label: t(MODE_KEY.poll), icon: MODE_ICON.poll }}
      title={t("shome.poll.title")}
      where={showWhere ? `${poll.courseCode} · ${poll.classroomName}` : undefined}
      status={{ label: t("shome.poll.status"), tone: "amber" }}
      meta={<MetaItem icon={Presentation}>{t("shome.poll.line")}</MetaItem>}
      action={{
        label: t("shome.poll.answer"),
        primary,
        onClick: () => navigate({ view: "join", code: poll.code }),
      }}
    />
  );
}

/**
 * A group set open to the student's self-formation (F-PROJ-22, S3): "Form
 * your group until …", in Open now, leading to the classroom's Groups tab.
 * Its button is never the page's primary — forming a group is not urgent
 * the way an exam closing is — and nothing is notified.
 */
export function GroupSetRow({
  card,
  navigate,
  showWhere = true,
}: {
  card: StudentGroupSetCard;
  navigate: (r: Route) => void;
  showWhere?: boolean;
}) {
  const t = useT();
  const route: Route = { view: "classroomGroups", id: card.classroomId };
  const go = () => navigate(route);
  return (
    <ActivityRow
      kind={{ label: t("sgroups.row.badge"), icon: Users }}
      title={t("sgroups.row.title", { when: isoDateTime(card.openUntil) })}
      link={{ href: routeToPath(route), onNavigate: go }}
      where={showWhere ? `${card.courseCode} · ${card.classroomName} · ${card.name}` : card.name}
      status={
        card.myGroup === null
          ? { label: t("sgroups.row.none"), tone: "amber" }
          : { label: t("sgroups.row.in", { group: card.myGroup }), tone: "green" }
      }
      action={{ label: t(card.myGroup === null ? "sgroups.row.choose" : "sgroups.row.see"), onClick: go }}
    />
  );
}

/**
 * The buttons of an evaluation card, the same on every page that lists them:
 * the one action of an open card (start, resume, retake, or Safe Exam
 * Browser's instructions, #270), and the review of a past one. `modal` is the
 * SEB instructions, to render once on the page.
 */
export function useCardActions(navigate: (r: Route) => void): {
  open: (card: EvaluationCardData, primary: boolean) => RowAction;
  review: (card: EvaluationCardData) => RowAction | undefined;
  modal: ReactNode;
} {
  const t = useT();
  // F-EVAL-15: another attempt, the same one the results page offers
  // (`retake.ts`). The server decides (`canRetake`, and `retake_refused` on
  // the route); on success the player opens on the new attempt.
  const retake = useRetake(navigate);
  // Issue #270: the SEB card opens its instructions; the file comes from there.
  const [sebFor, setSebFor] = useState<EvaluationCardData | null>(null);

  /** The one button of an open card. */
  const open = (card: EvaluationCardData, primary: boolean): RowAction => {
    // ADR-051: sat on a kiosk station only — the station starts it, once
    // paired from the phone; nothing opens here, not even a retake. The
    // button is the pairing page, for a code typed rather than scanned.
    if (kioskOnly(card)) {
      return { label: t("shome.kioskPair"), primary, onClick: () => navigate({ view: "pair" }) };
    }
    const r = card.retakes;
    if (r !== null && finished(card) && r.canRetake) {
      return {
        label: t("shome.retake"),
        primary,
        loading: retake.pendingFor === card.id,
        onClick: () => retake.start(card.id, r.keep),
      };
    }
    // Issue #203: a finished attempt that cannot be retaken is never here —
    // the server lists it under Past, where the results are.
    // ADR-027: sat in Safe Exam Browser — the card hands out the file,
    // after the instructions (#270).
    if (card.trustedClients.includes("seb")) {
      return { label: t("shome.seb"), primary, onClick: () => setSebFor(card) };
    }
    return {
      label: primaryAction(card, t),
      primary,
      onClick: () => navigate({ view: "attempt", evaluationId: card.id }),
    };
  };

  // WP10: the ONE student results page, offered only when the server says it
  // has something to show (issue #203). With retakes, the attempt that counts
  // (F-EVAL-15).
  const review = (card: EvaluationCardData): RowAction | undefined =>
    card.results === "available" && card.attemptId
      ? {
          label: t("shome.review"),
          onClick: () => navigate(feedbackLink(card.retakes?.kept?.attemptId ?? card.attemptId!).route),
        }
      : undefined;

  const modal = sebFor ? (
    <SebLaunchModal
      href={`/app/api/evaluations/${sebFor.id}/seb`}
      title={sebFor.title}
      conditions={sebFor.conditions}
      onClose={() => setSebFor(null)}
    />
  ) : null;

  return { open, review, modal };
}

/** "Extra time: +25%": the student's own time bonus, where it applies. */
export function BonusBadge({ percent }: { percent: number }) {
  const t = useT();
  return percent > 0 ? (
    <Badge tone="accent" icon={CalendarClock}>
      {t("shome.bonus", { n: percent })}
    </Badge>
  ) : null;
}

/**
 * One of the student's classrooms, pressable: it opens the classroom's page
 * (D07). The course, the period and the teachers name it; the time bonus is
 * the one thing in it about the student.
 */
function ClassroomCard({
  room,
  navigate,
}: {
  room: StudentClassroom;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const open = () => navigate({ view: "classroom", id: room.id });
  return (
    <Card
      interactive
      onClick={open}
      {...pressable(open, "link")}
      aria-label={room.name}
      className="flex flex-wrap items-center gap-x-5 gap-y-2 p-5"
    >
      <School className="size-5 shrink-0 text-fg-faint" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold tracking-tight">{room.name}</p>
        <p className="text-sm text-fg-muted">
          {room.courseCode} — {room.courseName}
          {room.period ? ` · ${room.period}` : ""}
        </p>
        {room.teachers.length > 0 ? (
          <p className="mt-1 text-[13px] text-fg-faint">
            {t("shome.teachers", { names: room.teachers.join(", ") })}
          </p>
        ) : null}
      </div>
      <BonusBadge percent={room.timeBonusPercent} />
    </Card>
  );
}

/**
 * The student's classrooms, each a door to its page — the home's "My classrooms" and the Courses page (F-ORG-14) alike.
 * Its four states are its own; the caller frames it (a section, a page).
 */
export function ClassroomList({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const rooms = useQuery<StudentClassroom[]>({
    queryKey: studentClassroomsKey,
    queryFn: () => api("/app/api/student/classrooms"),
  });
  return (
    <>
      {rooms.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : rooms.isError ? (
        <QueryError
          title={t("shome.classrooms")}
          error={rooms.error}
          onRetry={() => void rooms.refetch()}
          retrying={rooms.isFetching}
          fallback={t("error.server")}
        />
      ) : (rooms.data ?? []).length === 0 ? (
        <Card>
          <EmptyState icon={GraduationCap} title={t("shome.rooms.empty.title")}>
            {t("shome.rooms.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        rooms.data!.map((room) => <ClassroomCard key={room.id} room={room} navigate={navigate} />)
      )}
    </>
  );
}
