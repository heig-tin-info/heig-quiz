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
import { CalendarCheck, Dumbbell, PartyPopper } from "lucide-react";
import { useState } from "react";

import type { DrillSessionCard } from "@quiz/contracts";

import { useT } from "../i18n";
import type { Route } from "../router";
import {
  Button,
  Card,
  EmptyState,
  isoDateParts,
  PageHeader,
  QueryError,
  SegmentedBar,
  Skeleton,
} from "../ui";
import { useDrillClassrooms, useDrillDevice, useDrillSession } from "./api";
import { DrillClassrooms } from "./DrillClassrooms";
import { DrillRun, type DrillOutcome } from "./DrillRun";
import { sessionCourses, sessionLine } from "./format";

export function DrillPage({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const device = useDrillDevice();
  const rooms = useDrillClassrooms();
  const hasRooms = (rooms.data?.length ?? 0) > 0;
  const session = useDrillSession(device, hasRooms);
  const [run, setRun] = useState<readonly DrillSessionCard[] | null>(null);
  const [done, setDone] = useState<DrillOutcome[] | null>(null);

  if (run) {
    return (
      <DrillRun
        cards={run}
        device={device}
        onFinish={(outcomes) => {
          setRun(null);
          setDone(outcomes);
          // The badge and the empty day read the session again.
          void qc.invalidateQueries({ queryKey: ["student", "drill"] });
        }}
      />
    );
  }

  const day = () => {
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
    if (done) return <Summary outcomes={done} onHome={() => navigate({ view: "home" })} />;
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
        <Button onClick={() => setRun(today.cards)}>{t("drill.start")}</Button>
      </Card>
    );
  };

  return (
    <div className="space-y-8">
      <PageHeader title={t("drill.title")} description={t("drill.subtitle")} />
      {day()}
      {hasRooms ? <DrillClassrooms rooms={rooms.data!} /> : null}
    </div>
  );
}

/** The end of today's session: how it went, and the way back. */
function Summary({ outcomes, onHome }: { outcomes: DrillOutcome[]; onHome: () => void }) {
  const t = useT();
  const reviews = outcomes.filter((o) => o !== "skipped");
  const count = (c: "right" | "partial" | "wrong") => reviews.filter((r) => r.correctness === c).length;
  return (
    <Card className="space-y-5 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <PartyPopper aria-hidden className="mt-0.5 size-5 shrink-0 text-fg-faint" />
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-bold leading-snug tracking-tight">{t("drill.done.title")}</p>
          <p className="mt-0.5 text-sm text-fg-muted">
            {reviews.length === 1
              ? t("drill.done.body.one")
              : t("drill.done.body", { n: reviews.length })}
          </p>
        </div>
      </div>
      {reviews.length > 0 ? (
        <div className="space-y-2">
          <SegmentedBar
            parts={[
              { tone: "success", value: count("right"), label: t("drill.result.right") },
              { tone: "partial", value: count("partial"), label: t("drill.result.partial") },
              { tone: "danger", value: count("wrong"), label: t("drill.result.wrong") },
            ]}
          />
          <p className="text-[13px] tabular-nums text-fg-muted">
            {t("drill.done.counts", {
              right: count("right"),
              partial: count("partial"),
              wrong: count("wrong"),
            })}
          </p>
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button onClick={onHome}>{t("drill.done.home")}</Button>
      </div>
    </Card>
  );
}
