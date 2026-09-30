/**
 * The student's home.
 *
 * Three questions, in the order a student asks them: what can I do NOW, what
 * is coming, what did I already hand in. The classrooms and the join code
 * come last, because they are administration, not work. A classroom card
 * opens the classroom's page (D07).
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
 * Every list renders its five states (loading, error, empty, partial, ready).
 * The cards are the ones every student page shares (`cards.tsx`).
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { CheckCircle2, GraduationCap } from "lucide-react";

import type { DrillSession, Me, StudentClassroom, StudentHome as StudentHomeData } from "@quiz/contracts";

import { api } from "../api";
import { useDrillAvailability } from "../drill/api";
import { sessionCourses, sessionLine } from "../drill/format";
import { useT } from "../i18n";
import type { Route } from "../router";
import { Card, EmptyState, PageHeader, QueryError, SectionHeading, Skeleton, useNow } from "../ui";
import { studentClassroomsKey, studentHomeKey } from "../queryKeys";
import { HOME_SECTION } from "./bottomNavSlots";
import {
  ActivityRow,
  ClassroomCard,
  EvaluationRow,
  JoinCard,
  openLine,
  pastLine,
  PollRow,
  upcomingLine,
  useCardActions,
} from "./cards";

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

  const actions = useCardActions(navigate);
  // The ONE scroll of the bottom bar's section slot (#191): to the section
  // the address names once the lists are drawn, and back to the top when a
  // slot cleared it. Optional call: `scrollIntoView` does not exist under jsdom.
  const drawn = !home.isLoading && !rooms.isLoading;
  const hash = window.location.hash;
  const lastHash = useRef(hash);
  useEffect(() => {
    if (!drawn) return;
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView?.({ block: "start" });
    else if (lastHash.current) window.scrollTo({ top: 0 });
    lastHash.current = hash;
  }, [drawn, hash]);

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
                  line={openLine(card, now, t)}
                  action={actions.open(card, true)}
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
                  action={actions.review(card)}
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
          rooms.data!.map((room) => <ClassroomCard key={room.id} room={room} navigate={navigate} />)
        )}
        <JoinCard />
      </section>

      {actions.modal}
    </div>
  );
}
