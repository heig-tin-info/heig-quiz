/**
 * The student's home (mockup `05-etudiant-accueil.html`).
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
import { useState } from "react";
import { CalendarClock, CheckCircle2, GraduationCap, School } from "lucide-react";

import type {
  EvaluationCard as EvaluationCardData,
  JoinResult,
  Me,
  StudentClassroom,
  StudentHome as StudentHomeData,
} from "@quiz/contracts";

import { api } from "../api";
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
  isoDateTime,
  PageHeader,
  QueryError,
  SectionHeading,
  Skeleton,
  useNow,
} from "../ui";
import { studentClassroomsKey, studentHomeKey } from "../queryKeys";

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

function timingLine(card: EvaluationCardData, now: number, t: TFunction): string | null {
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

function upcomingLine(card: EvaluationCardData, now: number, t: TFunction): string {
  if (card.opensAt === null) return t("shome.upcoming.empty");
  const wait = Date.parse(card.opensAt) - now;
  return wait > 0
    ? t("shome.opensIn", { time: formatDuration(wait, t) })
    : t("shome.opensAt", { when: isoDateTime(card.opensAt) });
}

function EvaluationRow({
  card,
  line,
  action,
}: {
  card: EvaluationCardData;
  line: string | null;
  action?: { label: string; onClick: () => void; primary?: boolean };
}) {
  const t = useT();
  return (
    <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 p-5">
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-[17px] font-bold leading-snug tracking-tight">{card.title}</p>
        <p className="mt-0.5 text-sm text-fg-muted">
          {card.courseCode} · {card.classroomName}
        </p>
        {line ? <p className="mt-1 text-[13px] text-fg-faint">{line}</p> : null}
      </div>
      <Badge tone={card.mode === "exam" ? "accent" : "zinc"}>{t(MODE_KEY[card.mode])}</Badge>
      {action ? (
        <Button variant={action.primary ? "primary" : "secondary"} onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </Card>
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
            {open.length === 0 ? (
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
                  line={timingLine(card, now, t)}
                  action={{
                    label: primaryAction(card, t),
                    primary: true,
                    onClick: () => navigate({ view: "attempt", evaluationId: card.id }),
                  }}
                />
              ))
            )}
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

          <section className="space-y-3">
            <SectionHeading title={t("shome.past")} />
            {past.length === 0 ? (
              <Card className="px-5 py-4 text-sm text-fg-muted">{t("shome.past.empty")}</Card>
            ) : (
              past.map((card) => (
                <EvaluationRow
                  key={card.id}
                  card={card}
                  line={
                    card.attemptState === "submitted"
                      ? t("shome.state.submitted")
                      : card.attemptState === "expired"
                        ? t("shome.state.expired")
                        : t("shome.state.notStarted")
                  }
                  {...(card.attemptId
                    ? {
                        action: {
                          label: t("shome.review"),
                          // WP10: the ONE student results page. The API says
                          // `available: false` while the grades are not out,
                          // and the page renders that on its own.
                          onClick: () => navigate(feedbackLink(card.attemptId!).route),
                        },
                      }
                    : {})}
                />
              ))
            )}
          </section>
        </>
      )}

      <section className="space-y-3">
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
    </div>
  );
}
