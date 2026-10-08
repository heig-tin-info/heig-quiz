import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  CalendarX2,
  ChevronRight,
  KeyRound,
  ListChecks,
  MessageSquareText,
  MonitorPlay,
  RefreshCw,
  Rocket,
} from "lucide-react";
import { useState } from "react";

import type { Evaluation, EvaluationDetail } from "@quiz/contracts";
import { clockChoiceOf } from "@quiz/domain";

import { api, usePublicConfig } from "../api";
import { useT } from "../i18n";
import type { Route } from "../router";
import { Alert, Button, Card, cx, isoDateTime, LEVEL_ICON, useNow, type IconType } from "../ui";
import { launchChecks, lobbyKey, readiness, type LaunchCheck } from "./launchChecks";
import { LobbyPreviewColumn, LobbyPreviewRow } from "./LobbyPreview";
import { PullTemplateDialog } from "./templatePull";
import { transitionErrorMessage } from "./timing";
import { evaluationKey } from "../queryKeys";

/** The two steps a row of the checklist can lead back to. */
export type FixStep = "questions" | "timing";

/**
 * Step 3: the pre-flight checklist (#152, variant B), and the ONE action
 * that turns a configuration into something a class can enter.
 *
 * Which action that is depends on the state, and there is never more than
 * one: a draft opens the waiting room — or, with no waiting room at all
 * (`lobby: skip`), opens the evaluation itself; a Scheduled draft whose start
 * is to come is scheduled instead (ADR-086) — a lobby or a running
 * evaluation sends the teacher to the dashboard, which is where every live
 * control lives. Nothing here pauses or closes anything — a screen that
 * could start a quiz AND close it is a screen where the wrong button is one
 * row away from the right one.
 *
 * The four decisions: the contrast is the 20 px readiness heading over 14 px
 * rows; the accent is the launch button and nothing else (a warning is
 * amber, a blocker red, both semantic); rows are tight inside one card and
 * the card, the heading and the action bar are 24 apart; hairlines only.
 */
export function LaunchStep({
  detail,
  navigate,
  onStep,
}: {
  detail: EvaluationDetail;
  navigate: (r: Route) => void;
  /** Moves the configuration to another step, for a row's "fix it" link. */
  onStep: (step: FixStep) => void;
}) {
  const t = useT();
  const { evaluation } = detail;
  const id = evaluation.id;
  const live = evaluation.state === "lobby" || evaluation.state === "running" || evaluation.state === "paused";
  const finished = evaluation.state === "closed" || evaluation.state === "grading" || evaluation.state === "released";

  if (live) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
        <div className="min-w-0">
          <p className="font-semibold">{t("eval.launch.live")}</p>
          <p className="mt-0.5 text-sm text-fg-muted">{t("eval.launch.liveBody")}</p>
        </div>
        <Button onClick={() => navigate({ view: "live", id })}>
          <MonitorPlay /> {t("eval.launch.goLive")}
        </Button>
      </Card>
    );
  }
  if (finished) {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
        <p className="font-semibold">{t("eval.launch.closed")}</p>
        <Button variant="secondary" onClick={() => navigate({ view: "live", id })}>
          <MonitorPlay /> {t("eval.launch.goLive")}
        </Button>
      </Card>
    );
  }
  return <Checklist detail={detail} navigate={navigate} onStep={onStep} />;
}

/** An info row is a rule of the session, not a check: a neutral icon that says which. */
const INFO_ICON: Partial<Record<LaunchCheck["id"], IconType>> = {
  feedback: MessageSquareText,
  rules: ListChecks,
  access: KeyRound,
};

function Checklist({
  detail,
  navigate,
  onStep,
}: {
  detail: EvaluationDetail;
  navigate: (r: Route) => void;
  onStep: (step: FixStep) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { evaluation } = detail;
  const id = evaluation.id;
  const now = useNow();
  const [pulling, setPulling] = useState(false);
  // ADR-051: while the public configuration is unknown, no kiosk warning.
  const kioskAvailable = usePublicConfig().data?.kiosk !== null;
  const checks = launchChecks(detail, t, now, isoDateTime, kioskAvailable);
  const { blockers, warnings } = readiness(checks);
  const blocked = blockers > 0;
  const skip = evaluation.settings.lobby === "skip";
  /*
   * ADR-086: a Scheduled evaluation whose start is still to come is opened
   * by the platform, so scheduling it is THE action, and opening it at once
   * the secondary one. Live has no Schedule: its date is for the calendar
   * only, and the teacher opens the waiting room.
   */
  const toSchedule =
    clockChoiceOf(evaluation.settings).mode === "scheduled" &&
    evaluation.state === "draft" &&
    evaluation.opensAt !== null &&
    Date.parse(evaluation.opensAt) > now;
  const invalidate = () => qc.invalidateQueries({ queryKey: evaluationKey(id) });

  /*
   * With no waiting room the evaluation opens straight into `running`, the
   * move the ticker makes at `opensAt` for the same setting: posting `lobby`
   * there parked a take-home exercise in a room nobody starts (#152).
   */
  const open = useMutation({
    mutationFn: () =>
      skip
        ? api<Evaluation>(`/app/api/evaluations/${id}/start`, {
            method: "POST",
            body: JSON.stringify({ confirm: true }),
          })
        : api<Evaluation>(`/app/api/evaluations/${id}/state`, {
            method: "POST",
            body: JSON.stringify({ to: "lobby" }),
          }),
    onSuccess: invalidate,
  });
  const moveTo = (to: "draft" | "scheduled") =>
    api<Evaluation>(`/app/api/evaluations/${id}/state`, { method: "POST", body: JSON.stringify({ to }) });
  const schedule = useMutation({ mutationFn: () => moveTo("scheduled"), onSuccess: invalidate });
  const unschedule = useMutation({ mutationFn: () => moveTo("draft"), onSuccess: invalidate });
  const updateVersions = useMutation({
    mutationFn: () =>
      api(`/app/api/evaluations/${id}/items/update-versions`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: invalidate,
  });

  const heading = blocked
    ? { title: t("launch.heading.blocked"), detail: t("launch.heading.blocked.detail") }
    : warnings > 0
      ? {
          title: warnings === 1 ? t("launch.heading.warnOne") : t("launch.heading.warn", { n: warnings }),
          detail: t("launch.heading.warn.detail"),
        }
      : { title: t("launch.heading.ready"), detail: t("launch.heading.ready.detail") };

  // The status line says what the button will do, or why it cannot. A
  // blocked launch names the first blocker, the one the heading's list starts
  // with.
  const blocker = checks.find((c) => c.level === "blocker");
  const status = blocker
    ? (blocker.status ?? blocker.detail)
    : evaluation.state === "scheduled" && evaluation.opensAt !== null
      ? t("launch.status.scheduled", { date: isoDateTime(evaluation.opensAt) })
      : toSchedule
        ? t("launch.status.toSchedule", { date: isoDateTime(evaluation.opensAt!) })
        : `${t("launch.when.now")} ${t(lobbyKey(evaluation.settings.lobby))}`;

  const fix = (check: LaunchCheck) => {
    if (!check.fix) return;
    if (check.fix.kind === "step") onStep(check.fix.step);
    else if (check.fix.kind === "roster") {
      navigate({ view: "classroom", id: evaluation.classroomId, tab: "roster" });
    } else if (check.fix.kind === "pullTemplate") setPulling(true);
    else updateVersions.mutate();
  };

  const error = open.error ?? schedule.error ?? unschedule.error;
  const openLabel = toSchedule ? t("launch.openNow") : skip ? t("launch.open") : t("eval.launch.openLobby");

  // What the class will see (#152, variant C's preview): beside the list on
  // a wide screen, a row opening a sheet below that. An evaluation with no
  // waiting room has nothing to preview, and keeps the single column.
  const checklist = (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-bold tracking-[-0.01em]">{heading.title}</h2>
        <p className="mt-1 text-sm text-fg-muted">{heading.detail}</p>
      </header>

      <Card className="divide-y divide-line overflow-hidden">
        {checks.map((check) => (
          <CheckRow
            key={check.id}
            check={check}
            onFix={() => fix(check)}
            updating={updateVersions.isPending}
          />
        ))}
      </Card>

      {skip ? null : (
        <div className="lg:hidden">
          <LobbyPreviewRow detail={detail} />
        </div>
      )}

      {error ? (
        <Alert tone="danger" title={t("eval.launch.failed")}>
          {transitionErrorMessage(error, t, evaluation.settings.timing)}
        </Alert>
      ) : null}

      {/*
       * The action bar: in the flow on a desktop, a sticky dock within thumb
       * reach on a phone — the primary full width, the secondary as an icon
       * button beside it, and ONE status line above them. One DOM for both,
       * so a label or a disabled state can never differ between the two.
       */}
      <div data-bottom-dock="" className="sticky bottom-0 z-20 -mx-4 border-t border-line bg-surface px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-2.5 sm:static sm:mx-0 sm:flex sm:items-center sm:gap-4 sm:rounded-card sm:border sm:px-5 sm:py-4">
        <p role="status" className="text-center text-[13px] text-fg-muted sm:flex-1 sm:text-left">
          {status}
        </p>
        <div className="mt-2.5 flex items-center gap-2 sm:mt-0">
          {evaluation.state === "scheduled" ? (
            <Button
              variant="secondary"
              size="lg"
              className="max-sm:w-10 max-sm:px-0"
              aria-label={t("eval.launch.unschedule")}
              loading={unschedule.isPending}
              onClick={() => unschedule.mutate()}
            >
              {unschedule.isPending ? null : <CalendarX2 />}
              <span className="max-sm:sr-only">{t("eval.launch.unschedule")}</span>
            </Button>
          ) : toSchedule ? (
            <Button
              variant="secondary"
              size="lg"
              className="max-sm:w-10 max-sm:px-0"
              aria-label={openLabel}
              disabled={blocked}
              loading={open.isPending}
              onClick={() => open.mutate()}
            >
              {open.isPending ? null : <Rocket />}
              <span className="max-sm:sr-only">{openLabel}</span>
            </Button>
          ) : null}
          {toSchedule ? (
            <Button
              size="lg"
              className="max-sm:flex-1"
              disabled={blocked}
              loading={schedule.isPending}
              onClick={() => schedule.mutate()}
            >
              {schedule.isPending ? null : <CalendarClock />} {t("eval.launch.schedule")}
            </Button>
          ) : (
            <Button
              size="lg"
              className="max-sm:flex-1"
              disabled={blocked}
              loading={open.isPending}
              onClick={() => open.mutate()}
            >
              {open.isPending ? null : <Rocket />} {openLabel}
            </Button>
          )}
        </div>
      </div>

      {pulling ? (
        <PullTemplateDialog
          evaluationId={id}
          classroomId={evaluation.classroomId}
          onClose={() => setPulling(false)}
        />
      ) : null}
    </div>
  );

  if (skip) return <div className="mx-auto max-w-180">{checklist}</div>;
  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      {checklist}
      <div className="hidden lg:block">
        <LobbyPreviewColumn detail={detail} />
      </div>
    </div>
  );
}

/**
 * One line of the checklist. A row that leads somewhere is a button across
 * its whole width — on a phone the chevron is its only affordance, on a
 * desktop the name of the step it opens stands beside it. The stale-version
 * row fixes itself in place instead, so it carries a real button; so does
 * the template row, whose button opens the pull's confirmation (F-EVAL-26).
 */
function CheckRow({
  check,
  onFix,
  updating,
}: {
  check: LaunchCheck;
  onFix: () => void;
  updating: boolean;
}) {
  const t = useT();
  const level = check.level === "info" ? null : LEVEL_ICON[check.level];
  const Icon = level?.icon ?? INFO_ICON[check.id] ?? ListChecks;
  const tint =
    check.level === "blocker" ? "bg-danger-soft" : check.level === "warning" ? "bg-warning-soft" : "";
  const body = (
    <>
      <Icon className={cx("mt-0.5 size-4.5 shrink-0", level?.className ?? "text-fg-faint")} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{check.title}</span>
        <span className="mt-0.5 block text-[13px] text-fg-muted">{check.detail}</span>
      </span>
    </>
  );

  if (check.fix?.kind === "updateVersions" || check.fix?.kind === "pullTemplate") {
    const inPlace = check.fix.kind === "updateVersions";
    return (
      <div className={cx("flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3.5 sm:flex-nowrap sm:items-center sm:px-5", tint)}>
        <span className="flex min-w-0 flex-1 basis-full items-start gap-3 sm:basis-auto">{body}</span>
        <Button
          variant="secondary"
          size="sm"
          className="ml-7.5 sm:ml-0"
          loading={inPlace && updating}
          onClick={onFix}
        >
          {inPlace && updating ? null : <RefreshCw />}{" "}
          {t(inPlace ? "launch.update" : "launch.template.fix")}
        </Button>
      </div>
    );
  }

  const label =
    check.fix?.kind === "roster"
      ? t("roster.title")
      : check.fix?.kind === "step"
        ? t(check.fix.step === "questions" ? "eval.step.questions" : "eval.step.timing")
        : null;
  return (
    <button
      type="button"
      onClick={onFix}
      className={cx(
        "flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors sm:items-center sm:px-5",
        tint || "hover:bg-surface-2",
        "group",
      )}
    >
      {body}
      {label ? (
        <span className="hidden shrink-0 text-[13px] text-fg-muted underline decoration-line-strong underline-offset-4 group-hover:text-fg sm:inline">
          {label}
        </span>
      ) : null}
      <ChevronRight className="mt-0.5 size-4 shrink-0 text-fg-faint sm:hidden" aria-hidden />
    </button>
  );
}
