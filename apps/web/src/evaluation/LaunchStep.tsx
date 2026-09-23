import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, MonitorPlay, Rocket } from "lucide-react";

import type { Evaluation, EvaluationDetail } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { formatDuration, useT } from "../i18n";
import type { Route } from "../router";
import { Alert, Badge, Button, Card, isoDateTime, SectionHeading, Stat } from "../ui";
import { evaluationKey, evaluationStateLabel, stateTone } from "./common";

/**
 * Step 3: the last look, and the ONE action that turns a configuration into
 * something a class can enter.
 *
 * Which action that is depends on the state, and there is never more than
 * one: a draft opens the waiting room (or schedules itself for later), a
 * lobby or a running evaluation sends the teacher to the dashboard, which is
 * where every live control lives. Nothing here pauses or closes anything —
 * a screen that could start a quiz AND close it is a screen where the wrong
 * button is one row away from the right one.
 */
export function LaunchStep({
  detail,
  navigate,
}: {
  detail: EvaluationDetail;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { evaluation, items, totalPoints } = detail;
  const id = evaluation.id;
  const empty = items.length === 0;

  const transition = useMutation({
    mutationFn: (to: "draft" | "scheduled" | "lobby") =>
      api<Evaluation>(`/app/api/evaluations/${id}/state`, {
        method: "POST",
        body: JSON.stringify({ to }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: evaluationKey(id) }),
  });

  const live = evaluation.state === "lobby" || evaluation.state === "running" || evaluation.state === "paused";
  const finished = evaluation.state === "closed" || evaluation.state === "grading" || evaluation.state === "released";

  const timing =
    evaluation.settings.timing === "duration"
      ? evaluation.durationS === null
        ? "—"
        : formatDuration(evaluation.durationS * 1000, t)
      : evaluation.settings.timing === "deadline"
        ? evaluation.closesAt === null
          ? "—"
          : isoDateTime(evaluation.closesAt)
        : t("eval.timing.manual");

  return (
    <div className="space-y-5">
      <SectionHeading
        icon={Rocket}
        title={t("eval.step.launch")}
        description={t("eval.launch.desc")}
        actions={
          <Badge tone={stateTone(evaluation.state)}>
            {evaluationStateLabel(evaluation.state, t)}
          </Badge>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("eval.step.questions")} value={items.length} />
        <Stat label={t("eval.col.points")} value={totalPoints} />
        <Stat label={t("eval.timing")} value={timing} />
        <Stat
          label={t("eval.feedback")}
          value={t(`eval.feedback.${evaluation.feedbackPolicy.when}`)}
        />
      </div>

      {transition.isError ? (
        <Alert tone="danger" title={t("eval.saveFailed")}>
          {apiErrorMessage(transition.error, t("error.server"))}
        </Alert>
      ) : null}

      {empty ? <Alert tone="warning" title={t("eval.launch.needQuestions")} /> : null}

      {live ? (
        <Card className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
          <div className="min-w-0">
            <p className="font-semibold">{t("eval.launch.live")}</p>
            <p className="mt-0.5 text-sm text-fg-muted">{t("eval.launch.liveBody")}</p>
          </div>
          <Button onClick={() => navigate({ view: "live", id })}>
            <MonitorPlay /> {t("eval.launch.goLive")}
          </Button>
        </Card>
      ) : finished ? (
        <Card className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
          <p className="font-semibold">{t("eval.launch.closed")}</p>
          <Button variant="secondary" onClick={() => navigate({ view: "live", id })}>
            <MonitorPlay /> {t("eval.launch.goLive")}
          </Button>
        </Card>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            disabled={empty}
            loading={transition.isPending && transition.variables === "lobby"}
            onClick={() => transition.mutate("lobby")}
          >
            <Rocket /> {t("eval.launch.openLobby")}
          </Button>
          {evaluation.state === "scheduled" ? (
            <Button variant="secondary" onClick={() => transition.mutate("draft")}>
              {t("eval.launch.unschedule")}
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={empty}
              onClick={() => transition.mutate("scheduled")}
            >
              <CalendarClock /> {t("eval.launch.schedule")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
