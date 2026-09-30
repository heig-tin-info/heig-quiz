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

import { api, usePublicConfig } from "../api";
import { useT } from "../i18n";
import type { Route } from "../router";
import {
  Alert,
  Button,
  Card,
  cx,
  ErrorText,
  Field,
  FormDialog,
  isoDateTime,
  LEVEL_ICON,
  useNow,
  type IconType,
} from "../ui";
import { launchChecks, lobbyKey, readiness, type LaunchCheck } from "./launchChecks";
import { LobbyPreviewColumn, LobbyPreviewRow } from "./LobbyPreview";
import { PullTemplateDialog } from "./templatePull";
import { fromLocalInput, toLocalInput, transitionErrorMessage } from "./timing";
import { evaluationKey } from "../queryKeys";

/** The two steps a row of the checklist can lead back to. */
export type FixStep = "questions" | "timing";

/**
 * Step 3: the pre-flight checklist (#152, variant B), and the ONE action
 * that turns a configuration into something a class can enter.
 *
 * Which action that is depends on the state, and there is never more than
 * one: a draft opens the waiting room — or, with no waiting room at all
 * (`lobby: skip`), opens the evaluation itself — a lobby or a running
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
  const [scheduling, setScheduling] = useState(false);
  const [pulling, setPulling] = useState(false);
  // ADR-051: while the public configuration is unknown, no kiosk warning.
  const kioskAvailable = usePublicConfig().data?.kiosk !== null;
  const checks = launchChecks(detail, t, now, isoDateTime, kioskAvailable);
  const { blockers, warnings } = readiness(checks);
  const blocked = blockers > 0;
  const skip = evaluation.settings.lobby === "skip";
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
  const unschedule = useMutation({
    mutationFn: () =>
      api<Evaluation>(`/app/api/evaluations/${id}/state`, {
        method: "POST",
        body: JSON.stringify({ to: "draft" }),
      }),
    onSuccess: invalidate,
  });
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
    : (evaluation.state === "scheduled" && evaluation.opensAt !== null
      ? t("launch.status.scheduled", { date: isoDateTime(evaluation.opensAt) })
      : `${t("launch.when.now")} ${t(lobbyKey(evaluation.settings.lobby))}`);

  const fix = (check: LaunchCheck) => {
    if (!check.fix) return;
    if (check.fix.kind === "step") onStep(check.fix.step);
    else if (check.fix.kind === "roster") {
      navigate({ view: "classroom", id: evaluation.classroomId, tab: "roster" });
    } else if (check.fix.kind === "pullTemplate") setPulling(true);
    else updateVersions.mutate();
  };

  const error = open.error ?? unschedule.error;

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
          {transitionErrorMessage(error, t)}
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
          ) : (
            <Button
              variant="secondary"
              size="lg"
              className="max-sm:w-10 max-sm:px-0"
              aria-label={t("eval.launch.schedule")}
              disabled={blocked}
              onClick={() => setScheduling(true)}
            >
              <CalendarClock />
              <span className="max-sm:sr-only">{t("eval.launch.schedule")}</span>
            </Button>
          )}
          <Button
            size="lg"
            className="max-sm:flex-1"
            disabled={blocked}
            loading={open.isPending}
            onClick={() => open.mutate()}
          >
            {open.isPending ? null : <Rocket />} {skip ? t("launch.open") : t("eval.launch.openLobby")}
          </Button>
        </div>
      </div>

      {pulling ? (
        <PullTemplateDialog
          evaluationId={id}
          classroomId={evaluation.classroomId}
          onClose={() => setPulling(false)}
        />
      ) : null}
      {scheduling ? (
        <ScheduleDialog
          evaluation={evaluation}
          onClose={() => setScheduling(false)}
          onTiming={() => {
            setScheduling(false);
            onStep("timing");
          }}
          onDone={() => {
            setScheduling(false);
            void invalidate();
          }}
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

/**
 * "Schedule…": one field, the opening time (#152). The ticker opens a
 * scheduled evaluation at `opensAt` and at nothing else, and the server now
 * refuses a schedule without one — so the dialog asks for it rather than
 * switching the state silently. With a common end, the opening time is part
 * of the timing (decision D8: extra time is counted from it) and is edited
 * there; the dialog shows it and links to it instead of offering a second
 * place to change it.
 */
function ScheduleDialog({
  evaluation,
  onClose,
  onTiming,
  onDone,
}: {
  evaluation: Evaluation;
  onClose: () => void;
  onTiming: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const now = useNow();
  const deadline = evaluation.settings.timing === "deadline";
  const [value, setValue] = useState(() => toLocalInput(evaluation.opensAt));
  const opensAt = deadline ? evaluation.opensAt : fromLocalInput(value);
  // A convenience only: the server refuses a past opening by its own clock (#178).
  const past = opensAt !== null && Date.parse(opensAt) <= now;

  const schedule = useMutation({
    mutationFn: async () => {
      // Compared as the field shows it, to the minute: an untouched field
      // writes nothing.
      if (!deadline && value !== toLocalInput(evaluation.opensAt)) {
        await api(`/app/api/evaluations/${evaluation.id}`, {
          method: "PATCH",
          body: JSON.stringify({ opensAt }),
        });
      }
      return api<Evaluation>(`/app/api/evaluations/${evaluation.id}/state`, {
        method: "POST",
        body: JSON.stringify({ to: "scheduled" }),
      });
    },
    onSuccess: onDone,
  });

  return (
    <FormDialog
      title={t("launch.schedule.title")}
      onClose={onClose}
      onSubmit={() => schedule.mutate()}
      submitLabel={t("launch.schedule.submit")}
      submitting={schedule.isPending}
      canSubmit={opensAt !== null && !past}
      error={
        schedule.error ? (
          <ErrorText>{transitionErrorMessage(schedule.error, t)}</ErrorText>
        ) : null
      }
    >
      {deadline ? (
        <div className="space-y-1.5">
          <p className="text-[13px] font-medium">{t("eval.opensAt")}</p>
          <p className="text-sm tabular-nums">
            {evaluation.opensAt ? isoDateTime(evaluation.opensAt) : "—"}
          </p>
          <p className="text-[13px] text-fg-muted">
            {t("launch.schedule.deadline")}{" "}
            <button
              type="button"
              onClick={onTiming}
              className="font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg"
            >
              {t("launch.schedule.change")}
            </button>
          </p>
        </div>
      ) : (
        <Field
          label={t("eval.opensAt")}
          type="datetime-local"
          width="w-60"
          min={toLocalInput(new Date(now).toISOString())}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
      )}
      {past ? <ErrorText>{t("launch.schedule.past")}</ErrorText> : null}
      <p className="text-sm text-fg-muted">
        {t("launch.when.scheduled")} {t(lobbyKey(evaluation.settings.lobby))}
      </p>
    </FormDialog>
  );
}
