/**
 * The student's home.
 *
 * Two questions, in the order a student asks them: what can I do NOW, and
 * what is coming — the latter grouped by day, Today to Later (`UpcomingByDay`,
 * product owner 2026-10-01). What they already handed in is the Grades page's
 * (`/grades`, `StudentGrades`). The classrooms come last, because they are
 * administration, not work. A classroom card opens the classroom's page (D07).
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
import { CheckCircle2 } from "lucide-react";

import type { DrillSession, Me, StudentHome as StudentHomeData } from "@quiz/contracts";

import { api } from "../api";
import { useDrillAvailability } from "../drill/api";
import { sessionCourses, sessionLine } from "../drill/format";
import { useT } from "../i18n";
import type { Route } from "../router";
import { Card, EmptyState, PageHeader, QueryError, SectionHeading, Skeleton, useNow } from "../ui";
import { studentHomeKey } from "../queryKeys";
import {
  ActivityRow,
  ClassroomList,
  EvaluationRow,
  openLine,
  PollRow,
  UpcomingByDay,
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
  const actions = useCardActions(navigate);

  // ADR-041 §6 (#317): today's drill, while it holds something — the home's
  // "today's drill is available", beside what else is open now.
  const drill = useDrillAvailability(true).session;

  const polls = home.data?.polls ?? [];
  const open = home.data?.open ?? [];
  const upcoming = home.data?.upcoming ?? [];

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
              <UpcomingByDay cards={upcoming} now={now} />
            )}
          </section>
        </>
      )}

      <section className="space-y-3">
        <SectionHeading title={t("shome.classrooms")} />
        <ClassroomList navigate={navigate} />
      </section>

      {actions.modal}
    </div>
  );
}
