import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, MonitorPlay, Rocket } from "lucide-react";

import { TransitionRefusal, type Evaluation, type EvaluationDetail } from "@quiz/contracts";

import { ApiError, api } from "../api";
import { formatDuration, useT, type TFunction } from "../i18n";
import type { Route } from "../router";
import { Alert, Badge, Button, Card, isoDateTime, SectionHeading, Stat } from "../ui";
import { evaluationStateLabel, stateTone } from "./common";
import { missingTiming, missingTimingKey } from "./timing";
import { evaluationKey } from "../queryKeys";

/**
 * What a refused state change says, in the teacher's language (#76). The
 * server's `message` is English for logs and API clients; the screen reads
 * the machine half of the refusal instead: a missing question, the timing
 * fields still to fill, or a move the evaluation no longer allows because it
 * changed elsewhere. Anything else is the ordinary "server did not answer".
 */
export function transitionErrorMessage(error: unknown, t: TFunction): string {
  if (!(error instanceof ApiError)) return t("error.server");
  const refusal = TransitionRefusal.safeParse(error.body);
  if (!refusal.success) return t("error.server");
  const { reason, missing } = refusal.data;
  if (reason === "no_items") return t("eval.launch.needQuestions");
  if (reason === "timing_incomplete" && missing && missing.length > 0) {
    return missing.map((field) => t(missingTimingKey(field))).join(" ");
  }
  return t("eval.launch.stale");
}

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
  // The same rule the server applies before it opens the waiting room: a
  // tab click can bring the teacher here past the "Go to launch" check (#76).
  const missing = missingTiming(evaluation);
  const blocked = empty || missing.length > 0;

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

      {transition.error ? (
        <Alert tone="danger" title={t("eval.launch.failed")}>
          {transitionErrorMessage(transition.error, t)}
        </Alert>
      ) : null}

      {empty ? <Alert tone="warning" title={t("eval.launch.needQuestions")} /> : null}
      {!live && !finished && missing.length > 0 ? (
        <Alert tone="warning" title={t("eval.launch.needTiming")}>
          {missing.map((field) => t(missingTimingKey(field))).join(" ")}
        </Alert>
      ) : null}

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
            disabled={blocked}
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
              disabled={blocked}
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
