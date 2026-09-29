/**
 * The student's home.
 *
 * Three questions, in the order a student asks them: what can I do NOW, what
 * is coming, what did I already hand in. The classrooms and the join code
 * come last, because they are administration, not work.
 *
 * The four decisions:
 *   - Type: the open evaluation's title is the one 17 px line on the page;
 *     everything under it is 13–14 px. A student opening this at 23:40 must
 *     find the thing that closes at 23:59 without reading.
 *   - Color: ONE accent, the action on the open card. A card that is only
 *     coming up has no button at all, so the squint test shows exactly one
 *     red pill per open evaluation and nothing else.
 *   - Space: 32 between sections, 12 between cards of a list, 16–20 inside a
 *     card.
 *   - Finish: cards on the warm canvas, hairlines, no shadow.
 *
 * Every list renders its five states (loading, error, empty, partial, ready),
 * which is why the sections are one component taking a render function.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { CalendarClock, CheckCircle2, GraduationCap, School } from "lucide-react";

import { formatPoints } from "@quiz/domain";
import type {
  DrillSession,
  EvaluationCard as EvaluationCardData,
  JoinResult,
  Me,
  StudentClassroom,
  StudentHome as StudentHomeData,
  StudentPollCard,
} from "@quiz/contracts";

import { api } from "../api";
import { useDrillAvailability } from "../drill/api";
import { sessionCourses, sessionLine } from "../drill/format";
import { feedbackLink } from "../grading";
import { formatDuration, useT, type TFunction } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  isoDateParts,
  isoDateTime,
  PageHeader,
  QueryError,
  SectionHeading,
  Skeleton,
  useNow,
} from "../ui";
import { studentClassroomsKey, studentHomeKey } from "../queryKeys";
import { HOME_SECTION } from "./bottomNavSlots";
import { useRetake } from "./retake";
import { SebLaunchModal } from "./SebLaunchModal";

const MODE_KEY = {
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
const finished = (card: EvaluationCardData): boolean =>
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

/**
 * The line of a past card: how the attempt ended (or the retake count), and,
 * issue #203, that the results are still to come when the server says so
 * (`results: "pending"`) — the card has no button for them then, so the
 * student reads it here instead of on an empty page. A score already on the
 * line (between two attempts) needs no such note.
 */
function pastLine(card: EvaluationCardData, t: TFunction): string {
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

function upcomingLine(card: EvaluationCardData, now: number, t: TFunction): string {
  if (card.opensAt === null) return t("shome.upcoming.empty");
  const wait = Date.parse(card.opensAt) - now;
  return wait > 0
    ? t("shome.opensIn", { time: formatDuration(wait, t) })
    : t("shome.opensAt", { when: isoDateTime(card.opensAt) });
}

type RowAction = {
  label: string;
  onClick: () => void | Promise<void>;
  primary?: boolean;
  loading?: boolean;
};

/** One card of a list: what it is, where it comes from, one line, one button. */
function ActivityRow({
  title,
  where,
  line,
  badge,
  action,
}: {
  title: string;
  where: string;
  line: string | null;
  badge: { label: string; accent: boolean };
  action?: RowAction | undefined;
}) {
  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 p-5">
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-[17px] font-bold leading-snug tracking-tight">{title}</p>
        <p className="mt-0.5 text-sm text-fg-muted">{where}</p>
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

function EvaluationRow({
  card,
  line,
  action,
}: {
  card: EvaluationCardData;
  line: string | null;
  action?: RowAction;
}) {
  const t = useT();
  return (
    <ActivityRow
      title={card.title}
      where={`${card.courseCode} · ${card.classroomName}`}
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
function PollRow({ poll, navigate }: { poll: StudentPollCard; navigate: (r: Route) => void }) {
  const t = useT();
  return (
    <ActivityRow
      title={t("shome.poll.title")}
      where={`${poll.courseCode} · ${poll.classroomName}`}
      line={t("shome.poll.line")}
      badge={{ label: t(MODE_KEY.poll), accent: false }}
      action={{
        label: t("shome.poll.answer"),
        primary: true,
        onClick: () => navigate({ view: "join", code: poll.code }),
      }}
    />
  );
}

/**
 * Today's drill (ADR-041 §6), drawn only while it holds something. Its badge
 * is the home's "today's drill is available"; its button is secondary, since
 * an evaluation open now is what the page's primary is for.
 */
function DrillRow({ session, navigate }: { session: DrillSession; navigate: (r: Route) => void }) {
  const t = useT();
  return (
    <ActivityRow
      title={t("drill.today.title")}
      where={sessionCourses(session.cards)}
      line={sessionLine(session, t)}
      badge={{ label: t("drill.badge"), accent: true }}
      action={{ label: t("drill.practise"), onClick: () => navigate({ view: "drill" }) }}
    />
  );
}

function JoinCard() {
  const t = useT();
  const toast = useToast();
  const toastError = useErrorToast();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const join = async () => {
    setBusy(true);
    try {
      const result = await api<JoinResult>(`/app/api/join/${encodeURIComponent(code.trim())}`, {
        method: "POST",
      });
      toast(
        t(result.status === "joined" ? "join.joined" : "join.already", {
          name: result.classroomName,
        }),
        "success",
      );
      setCode("");
    } catch (error) {
      toastError("join.failed")(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-5">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void join();
        }}
      >
        <div className="min-w-0 flex-1 basis-60 sm:max-w-80">
          <Field
            data-coach="student.join"
            label={t("join.label")}
            placeholder={t("join.placeholder")}
            fullWidth
            value={code}
            autoComplete="off"
            onChange={(e) => setCode(e.target.value)}
          />
          <p className="mt-1.5 text-[13px] text-fg-faint">{t("join.hint")}</p>
        </div>
        <Button type="submit" variant="secondary" loading={busy} disabled={code.trim().length < 4}>
          {t("join.action")}
        </Button>
      </form>
    </Card>
  );
}

export function StudentHome({ me, navigate }: { me: Me; navigate: (r: Route) => void }) {
  const t = useT();
  const now = useNow(30_000);
  const home = useQuery<StudentHomeData>({
    queryKey: studentHomeKey,
    queryFn: () => api("/app/api/student/home"),
  });
  const rooms = useQuery<StudentClassroom[]>({
    queryKey: studentClassroomsKey,
    queryFn: () => api("/app/api/student/classrooms"),
  });

  // F-EVAL-15: another attempt, the same one the results page offers
  // (`retake.ts`). The server decides (`canRetake`, and `retake_refused` on
  // the route); on success the player opens on the new attempt.
  const retake = useRetake(navigate);
  // The ONE scroll of the bottom bar's slots (#191): to the section the
  // address names once the lists are drawn, and back to the top when a slot
  // cleared it. Optional call: `scrollIntoView` does not exist under jsdom.
  const drawn = !home.isLoading && !rooms.isLoading;
  const hash = window.location.hash;
  const lastHash = useRef(hash);
  useEffect(() => {
    if (!drawn) return;
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView?.({ block: "start" });
    else if (lastHash.current) window.scrollTo({ top: 0 });
    lastHash.current = hash;
  }, [drawn, hash]);
  // Issue #270: the SEB card opens its instructions; the file comes from there.
  const [sebFor, setSebFor] = useState<EvaluationCardData | null>(null);

  /** The one button of an open card. */
  const openAction = (card: EvaluationCardData) => {
    const r = card.retakes;
    if (r !== null && finished(card) && r.canRetake) {
      return {
        label: t("shome.retake"),
        primary: true,
        loading: retake.pendingFor === card.id,
        onClick: () => retake.start(card.id, r.keep),
      };
    }
    // Issue #203: a finished attempt that cannot be retaken is never here —
    // the server lists it under Past, where the results are.
    // ADR-027: sat in Safe Exam Browser only — the card hands out the file,
    // after the instructions (#270).
    if (card.safeExamBrowser) {
      return {
        label: t("shome.seb"),
        primary: true,
        onClick: () => setSebFor(card),
      };
    }
    return {
      label: primaryAction(card, t),
      primary: true,
      onClick: () => navigate({ view: "attempt", evaluationId: card.id }),
    };
  };

  // ADR-041 §6 (#317): today's drill, while it holds something — the home's
  // "today's drill is available", beside what else is open now.
  const drill = useDrillAvailability(true).session;

  const polls = home.data?.polls ?? [];
  const open = home.data?.open ?? [];
  const upcoming = home.data?.upcoming ?? [];
  const past = home.data?.past ?? [];

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("shome.greeting", { name: me.givenName || me.familyName })}
        description={t("shome.subtitle")}
      />

      {home.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : home.isError ? (
        <QueryError
          title={t("shome.open")}
          error={home.error}
          onRetry={() => void home.refetch()}
          retrying={home.isFetching}
          fallback={t("error.server")}
        />
      ) : (
        <>
          <section className="space-y-3">
            <SectionHeading title={t("shome.open")} />
            {polls.map((poll) => (
              <PollRow key={poll.id} poll={poll} navigate={navigate} />
            ))}
            {open.length === 0 && polls.length === 0 && !drill ? (
              <Card>
                <EmptyState icon={CheckCircle2} title={t("shome.empty.title")}>
                  {t("shome.empty.body")}
                </EmptyState>
              </Card>
            ) : (
              open.map((card) => (
                <EvaluationRow
                  key={card.id}
                  card={card}
                  line={
                    card.retakes !== null && finished(card)
                      ? retakeLine(card, t)
                      : timingLine(card, now, t)
                  }
                  action={openAction(card)}
                />
              ))
            )}
            {/* After what closes: an evaluation open now is the more urgent. */}
            {drill ? <DrillRow session={drill} navigate={navigate} /> : null}
          </section>

          <section className="space-y-3">
            <SectionHeading title={t("shome.upcoming")} />
            {upcoming.length === 0 ? (
              <Card className="px-5 py-4 text-sm text-fg-muted">{t("shome.upcoming.empty")}</Card>
            ) : (
              upcoming.map((card) => (
                <EvaluationRow key={card.id} card={card} line={upcomingLine(card, now, t)} />
              ))
            )}
          </section>

          <section id={HOME_SECTION.grades} className="space-y-3">
            <SectionHeading title={t("shome.past")} />
            {past.length === 0 ? (
              <Card className="px-5 py-4 text-sm text-fg-muted">{t("shome.past.empty")}</Card>
            ) : (
              past.map((card) => (
                <EvaluationRow
                  key={card.id}
                  card={card}
                  line={pastLine(card, t)}
                  {...(card.results === "available" && card.attemptId
                    ? {
                        action: {
                          label: t("shome.review"),
                          // WP10: the ONE student results page, offered only
                          // when the server says it has something to show
                          // (issue #203). With retakes, the attempt that
                          // counts (F-EVAL-15).
                          onClick: () =>
                            navigate(
                              feedbackLink(card.retakes?.kept?.attemptId ?? card.attemptId!).route,
                            ),
                        },
                      }
                    : {})}
                />
              ))
            )}
          </section>
        </>
      )}

      <section id={HOME_SECTION.courses} className="space-y-3">
        <SectionHeading title={t("shome.classrooms")} />
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
          rooms.data!.map((room) => (
            <Card key={room.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 p-5">
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
              {room.timeBonusPercent > 0 ? (
                <Badge tone="accent" icon={CalendarClock}>
                  {t("shome.bonus", { n: room.timeBonusPercent })}
                </Badge>
              ) : null}
            </Card>
          ))
        )}
        <JoinCard />
      </section>

      {sebFor ? (
        <SebLaunchModal
          evaluationId={sebFor.id}
          title={sebFor.title}
          onClose={() => setSebFor(null)}
        />
      ) : null}
    </div>
  );
}
