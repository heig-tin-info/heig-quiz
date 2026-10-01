/**
 * The cards the student's pages share: the activity rows (an evaluation, a
 * running poll), their one-line captions, and the list of classrooms. The
 * home (`StudentHome`) lists them across every classroom, the
 * classroom page (`StudentClassroom`) for one, the Courses page
 * (`StudentCourses`) the classrooms (F-ORG-14, F-ORG-15).
 *
 * A row decides nothing about emphasis: the page says which button is the
 * primary, since the home lights every open card and the classroom page only
 * its most urgent one.
 */
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { CalendarClock, GraduationCap, School } from "lucide-react";

import { formatPoints } from "@quiz/domain";
import type {
  EvaluationCard as EvaluationCardData,
  StudentClassroom,
  StudentPollCard,
} from "@quiz/contracts";

import { api } from "../api";
import { feedbackLink } from "../grading";
import { formatDuration, useT, type TFunction } from "../i18n";
import { studentClassroomsKey } from "../queryKeys";
import type { Route } from "../router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  isoDateParts,
  isoDateTime,
  pressable,
  QueryError,
  Skeleton,
} from "../ui";
import { useRetake } from "./retake";
import { SebLaunchModal } from "./SebLaunchModal";

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
function timingLine(card: EvaluationCardData, now: number, t: TFunction): string | null {
  const left = timeLeftLine(card, now, t);
  if (card.attemptState !== "in_progress" || card.attemptStartedAt === null) return left;
  const started = t("shome.startedAt", isoDateParts(card.attemptStartedAt));
  return left === null ? started : `${started} · ${left}`;
}

function timeLeftLine(card: EvaluationCardData, now: number, t: TFunction): string | null {
  if (card.deadlineAt !== null) {
    const left = Date.parse(card.deadlineAt) - now;
    if (left > 0) return t("shome.left", { time: formatDuration(left, t) });
  }
  if (card.closesAt !== null) {
    const left = Date.parse(card.closesAt) - now;
    if (left > 0) return t("shome.left", { time: formatDuration(left, t) });
    return t("shome.dueAt", { when: isoDateTime(card.closesAt) });
  }
  if (card.durationS !== null) return t("shome.duration", { n: Math.round(card.durationS / 60) });
  return null;
}

/** A finished attempt: handed in, or closed by time or by the teacher. */
export const finished = (card: EvaluationCardData): boolean =>
  card.attemptState === "submitted" || card.attemptState === "expired";

/**
 * F-EVAL-15: the line of an exercise with retakes once an attempt is done —
 * the score that counts (best or last) and how many attempts were taken.
 * The score is all the student reads between two attempts (ADR-025).
 */
function retakeLine(card: EvaluationCardData, t: TFunction): string | null {
  const r = card.retakes;
  if (r === null) return null;
  const parts: string[] = [];
  // `score` is null once the exercise is closed and the feedback policy
  // hides it (on release, none): the card says no more than the feedback page.
  if (r.kept !== null && r.kept.score !== null) {
    parts.push(
      t(r.keep === "best" ? "shome.kept.best" : "shome.kept.last", {
        points: formatPoints(r.kept.score.points),
        total: formatPoints(r.kept.score.totalPoints),
      }),
    );
  }
  parts.push(
    r.maxAttempts === null
      ? t("shome.attempts", { n: r.attemptCount })
      : t("shome.attemptsOf", { n: r.attemptCount, max: r.maxAttempts }),
  );
  if (r.kept?.score?.pending) parts.push(t("shome.kept.pending"));
  return parts.join(" · ");
}

/** ADR-051 §2: an exam sat on a kiosk station and nowhere else. */
const kioskOnly = (card: EvaluationCardData): boolean =>
  card.trustedClients.includes("kiosk") && !card.trustedClients.includes("seb");

/**
 * The line of an open card: where to sit it for a kiosk-only exam, the
 * retake count once done, the time left otherwise.
 */
export function openLine(card: EvaluationCardData, now: number, t: TFunction): string | null {
  if (kioskOnly(card)) return t("shome.kiosk");
  return card.retakes !== null && finished(card) ? retakeLine(card, t) : timingLine(card, now, t);
}

/**
 * The line of a past card: how the attempt ended (or the retake count), and,
 * issue #203, that the results are still to come when the server says so
 * (`results: "pending"`) — the card has no button for them then, so the
 * student reads it here instead of on an empty page. A score already on the
 * line (between two attempts) needs no such note.
 */
export function pastLine(card: EvaluationCardData, t: TFunction): string {
  const base =
    card.retakes !== null && card.attemptId !== null
      ? retakeLine(card, t)!
      : card.attemptState === "submitted"
        ? t("shome.state.submitted")
        : card.attemptState === "expired"
          ? t("shome.state.expired")
          : t("shome.state.notStarted");
  const waiting = finished(card) && card.results === "pending" && !card.retakes?.kept?.score;
  return waiting ? `${base} · ${t("shome.resultsPending")}` : base;
}

export function upcomingLine(card: EvaluationCardData, now: number, t: TFunction): string {
  if (card.opensAt === null) return t("shome.upcoming.empty");
  const wait = Date.parse(card.opensAt) - now;
  return wait > 0
    ? t("shome.opensIn", { time: formatDuration(wait, t) })
    : t("shome.opensAt", { when: isoDateTime(card.opensAt) });
}

export type RowAction = {
  label: string;
  onClick: () => void | Promise<void>;
  primary?: boolean;
  loading?: boolean;
};

/** One card of a list: what it is, where it comes from, one line, one button. */
export function ActivityRow({
  title,
  where,
  line,
  badge,
  action,
}: {
  title: string;
  /** Absent on a page that is already the classroom's. */
  where?: string | undefined;
  line: string | null;
  badge: { label: string; accent: boolean };
  action?: RowAction | undefined;
}) {
  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 p-5">
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-[17px] font-bold leading-snug tracking-tight">{title}</p>
        {where ? <p className="mt-0.5 text-sm text-fg-muted">{where}</p> : null}
        {line ? <p className="mt-1 text-[13px] text-fg-faint">{line}</p> : null}
      </div>
      <Badge tone={badge.accent ? "accent" : "zinc"}>{badge.label}</Badge>
      {action ? (
        <Button
          variant={action.primary ? "primary" : "secondary"}
          onClick={() => void action.onClick()}
          loading={action.loading ?? false}
        >
          {action.label}
        </Button>
      ) : null}
    </Card>
  );
}

/** `showWhere` is false on the classroom's own page, where every row is of that classroom. */
export function EvaluationRow({
  card,
  line,
  action,
  showWhere = true,
}: {
  card: EvaluationCardData;
  line: string | null;
  action?: RowAction | undefined;
  showWhere?: boolean;
}) {
  const t = useT();
  return (
    <ActivityRow
      title={card.title}
      where={showWhere ? `${card.courseCode} · ${card.classroomName}` : undefined}
      line={line}
      badge={{ label: t(MODE_KEY[card.mode]), accent: card.mode === "exam" }}
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
      title={t("shome.poll.title")}
      where={showWhere ? `${poll.courseCode} · ${poll.classroomName}` : undefined}
      line={t("shome.poll.line")}
      badge={{ label: t(MODE_KEY.poll), accent: false }}
      action={{
        label: t("shome.poll.answer"),
        primary,
        onClick: () => navigate({ view: "join", code: poll.code }),
      }}
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
    <SebLaunchModal evaluationId={sebFor.id} title={sebFor.title} onClose={() => setSebFor(null)} />
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
