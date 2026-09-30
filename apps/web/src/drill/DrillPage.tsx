/**
 * The student's drill (F-DRILL-03, ADR-041 §6): today's session, its end,
 * or the day with nothing left; and the classrooms it draws from.
 *
 * The four decisions:
 *   - Type: the page title, then ONE 17 px line for the thing to do (today's
 *     drill, the end of it, or the empty day); everything else 13–14 px.
 *   - Color: one accent, the page's one primary — Start, then Check and Next
 *     inside the run (`DrillRun`), then Back to home. The switches are the
 *     success green of every switch; nothing else is coloured.
 *   - Space: 32 between the day and the classrooms, 16–20 inside a card.
 *   - Finish: cards on the warm canvas, hairlines, no shadow.
 *
 * The run takes the page while it lasts: the classrooms and the header go,
 * one card at a time is all there is.
 */
import { useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, Dumbbell } from "lucide-react";
import { useState } from "react";

import type { DrillSessionCard } from "@quiz/contracts";

import { useT } from "../i18n";
import { drillRootKey } from "../queryKeys";
import type { Route } from "../router";
import { Button, Card, EmptyState, isoDateParts, PageHeader, QueryError, Skeleton } from "../ui";
import { useDrillClassrooms, useDrillDevice, useDrillSession } from "./api";
import { DrillClassrooms } from "./DrillClassrooms";
import { DrillRun, DrillSummary, type DrillOutcome } from "./DrillRun";
import { sessionCourses, sessionLine } from "./format";

/** Where the page is: the day as the server has it, a session running, or one just finished. */
type Step =
  | { step: "day" }
  | { step: "run"; cards: readonly DrillSessionCard[] }
  | { step: "done"; outcomes: DrillOutcome[] };

export function DrillPage({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const device = useDrillDevice();
  const rooms = useDrillClassrooms();
  const hasRooms = (rooms.data?.length ?? 0) > 0;
  const session = useDrillSession(device, hasRooms);
  const [state, setState] = useState<Step>({ step: "day" });

  if (state.step === "run") {
    return (
      <DrillRun
        cards={state.cards}
        device={device}
        onFinish={(outcomes) => {
          setState({ step: "done", outcomes });
          // The badge and the empty day read the session again.
          void qc.invalidateQueries({ queryKey: drillRootKey });
        }}
      />
    );
  }

  const day = () => {
    // The end of the session is the page's own state: the refetch it
    // started must not blank it out.
    if (state.step === "done") {
      return <DrillSummary outcomes={state.outcomes} onHome={() => navigate({ view: "home" })} />;
    }
    if (rooms.isLoading || (hasRooms && session.isLoading)) {
      return <Skeleton className="h-32 w-full" />;
    }
    const failed = rooms.isError ? rooms : session.isError ? session : null;
    if (failed) {
      return (
        <QueryError
          title={t("drill.loadFailed")}
          error={failed.error}
          onRetry={() => void failed.refetch()}
          retrying={failed.isFetching}
        />
      );
    }
    if (!hasRooms) {
      return (
        <Card>
          <EmptyState icon={Dumbbell} title={t("drill.off.title")}>
            {t("drill.off.body")}
          </EmptyState>
        </Card>
      );
    }
    const today = session.data!;
    if (today.cards.length === 0) {
      return (
        <Card>
          <EmptyState icon={CalendarCheck} title={t("drill.empty.title")}>
            {today.nextDueAt
              ? t("drill.empty.next", { date: isoDateParts(today.nextDueAt).date })
              : t("drill.empty.none")}
          </EmptyState>
        </Card>
      );
    }
    return (
      <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 p-5">
        <div className="min-w-0 flex-1 basis-60">
          <p className="text-[17px] font-bold leading-snug tracking-tight">{t("drill.today.title")}</p>
          <p className="mt-0.5 text-sm text-fg-muted">{sessionCourses(today.cards)}</p>
          <p className="mt-1 text-[13px] text-fg-faint">{sessionLine(today, t)}</p>
        </div>
        <Button onClick={() => setState({ step: "run", cards: today.cards })}>{t("drill.start")}</Button>
      </Card>
    );
  };

  return (
    <div className="space-y-8">
      <PageHeader title={t("nav.drill")} description={t("drill.subtitle")} />
      {day()}
      {hasRooms ? <DrillClassrooms rooms={rooms.data!} /> : null}
    </div>
  );
}
