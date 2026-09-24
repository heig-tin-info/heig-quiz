import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  ClipboardCheck,
  Copy,
  MonitorPlay,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { EvaluationPatch, type ClassroomDetail, type EvaluationDetail } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { gradingLinks } from "../grading";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import type { Route } from "../router";
import { useSearchParam } from "../router";
import {
  Badge,
  Button,
  cx,
  FormError,
  InlineTitle,
  Menu,
  PageError,
  PageHeader,
  PageSkeleton,
  ParentLink,
  TabPanel,
  Tabs,
} from "../ui";
import {
  evaluationStateLabel,
  isGraded,
  stateTone,
} from "./common";
import { ItemsStep } from "./ItemsStep";
import { LaunchStep } from "./LaunchStep";
import { missingTiming, TIMING_FIELD_ID } from "./timing";
import { TimingStep } from "./TimingStep";
import { useEvaluationPatch } from "./usePatch";
import { classroomKey, evaluationKey, evaluationsKey } from "../queryKeys";

/**
 * The three-screen configuration of docs/spec/08 §8.2: choose the questions,
 * set the time, start. They are tabs and not a wizard with a locked order — a
 * teacher preparing next week's quiz opens it six times and lands on the step
 * they left, which a wizard would make them walk through again. The step
 * lives in `?step=`, so that reload keeps it and a link can point at it.
 *
 * The one primary action belongs to the STEP, never to the page HEADER: "Add
 * questions" on the first, a preset on the second, "Open the waiting room" on
 * the third. The header therefore holds no primary at all — a breadcrumb, the
 * title (which renames itself in place), the state, the help and the overflow
 * menu. The foot of the frame carries the way FORWARD, which names the step it
 * leads to; on Launch it carries only the way back, because the primary there
 * is the launch itself.
 *
 * The header used to carry two more buttons and both are gone. "Preview as
 * student" opened a read-only sheet of the whole evaluation; "View as student"
 * walked the real thing. The second is now the `Teacher | Student` switch of
 * the application frame (ADR-018's addendum), reachable from every page
 * instead of this one, and with it gone the read-only sheet was the lesser
 * half of a pair that no longer exists.
 */

const STEPS = ["questions", "timing", "launch"] as const;
type Step = (typeof STEPS)[number];

function isStep(value: string): value is Step {
  return (STEPS as readonly string[]).includes(value);
}

export function EvaluationConfig({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const [rawStep, setStep] = useSearchParam("step", "questions");
  const step: Step = isStep(rawStep) ? rawStep : "questions";
  /** The teacher tried "Go to launch" with the timing incomplete (#76). */
  const [timingChecked, setTimingChecked] = useState(false);

  const detail = useQuery<EvaluationDetail>({
    queryKey: evaluationKey(id),
    queryFn: () => api(`/app/api/evaluations/${id}`),
  });
  const patch = useEvaluationPatch(id);
  const classroomId = detail.data?.evaluation.classroomId ?? null;
  const classroom = useQuery<ClassroomDetail>({
    queryKey: classroomKey(classroomId),
    enabled: classroomId !== null,
    queryFn: () => api(`/app/api/classrooms/${classroomId}`),
  });

  const duplicate = useMutation({
    mutationFn: (title: string) =>
      api<{ id: string }>(`/app/api/evaluations/${id}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ title }),
      }),
    onSuccess: async (row) => {
      if (classroomId) await qc.invalidateQueries({ queryKey: evaluationsKey(classroomId) });
      navigate({ view: "evaluation", id: row.id });
    },
  });
  /** The teacher throws away their own staff test so they can walk it again. */
  const resetAttempt = useMutation({
    mutationFn: () => api(`/app/api/evaluations/${id}/attempt`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: evaluationKey(id) });
      toast(t("eval.resetAttempt.done"), "success");
    },
    onError: toastError("eval.resetAttempt.failed"),
  });

  const remove = useMutation({
    mutationFn: (confirmTitle: string) =>
      api(`/app/api/evaluations/${id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmTitle }),
      }),
    onSuccess: async () => {
      if (classroomId) {
        await qc.invalidateQueries({ queryKey: evaluationsKey(classroomId) });
        navigate({ view: "classroom", id: classroomId });
      } else {
        navigate({ view: "home" });
      }
    },
  });

  if (detail.isLoading) {
    return <PageSkeleton header="title-and-bar" />;
  }
  if (detail.isError || !detail.data) {
    return (
      <PageError
        title={t("eval.notFound")}
        error={detail.error}
        onRetry={() => void detail.refetch()}
        retrying={detail.isFetching}
        fallback={t("error.server")}
      />
    );
  }

  const data = detail.data;
  const evaluation = data.evaluation;
  const links = gradingLinks(id);
  const self = data.self;

  /*
   * The title, renamed from the heading itself. The same `PATCH` every other
   * control of the screen sends, and the same schema the route validates —
   * a title trimmed to nothing, or longer than the column, never leaves the
   * browser. `title` is one of the few fields the server still accepts once a
   * student has started (SAFE_FIELDS), so the affordance stays on a frozen
   * evaluation: what is frozen there is the structure, not its name.
   */
  /*
   * "Go to launch" is where an incomplete timing is caught (#76), not the
   * launch button two screens later: the teacher stays on the step that
   * holds the missing field, every such field is marked with what to enter,
   * and the focus lands on the first one. The server applies the same rule
   * (`missingTimingFields`) when it refuses to open the waiting room.
   */
  const goToLaunch = () => {
    // Only an evaluation still to be opened has something to fix here; a
    // live or closed one goes to its launch step, which then leads to the
    // dashboard.
    const opening = evaluation.state === "draft" || evaluation.state === "scheduled";
    const missing = opening ? missingTiming(evaluation) : [];
    if (missing.length === 0) {
      setStep("launch");
      return;
    }
    setTimingChecked(true);
    const target = document.getElementById(TIMING_FIELD_ID[missing[0]!]);
    // The timing row is a radio group: the focus goes to the choice in force.
    const control =
      target instanceof HTMLInputElement
        ? target
        : target?.querySelector<HTMLInputElement>("input:checked");
    control?.focus();
  };

  const rename = (title: string) => {
    const parsed = EvaluationPatch.safeParse({ title });
    if (!parsed.success) return;
    patch.mutate(parsed.data, {
      onSuccess: () => toast(t("sync.saved"), "success"),
      onError: toastError("eval.saveFailed"),
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          classroomId ? (
            <ParentLink onClick={() => navigate({ view: "classroom", id: classroomId })}>
              {classroom.data
                ? `${classroom.data.course.code} — ${classroom.data.name}`
                : t("eval.title")}
            </ParentLink>
          ) : null
        }
        title={
          <span className="flex flex-wrap items-baseline gap-3">
            <InlineTitle
              value={evaluation.title}
              onSave={rename}
              editLabel={t("eval.rename.of", { title: evaluation.title })}
              inputLabel={t("eval.titleLabel")}
            />
            <Badge tone={stateTone(evaluation.state)}>{evaluationStateLabel(evaluation.state, t)}</Badge>
          </span>
        }
        help="evaluation"
        actions={
          <>
            {/* WP10: once it is closed, the correction is where this screen
                leads — the configuration is history at that point. */}
            {isGraded(evaluation.state) ? (
              <Button variant="secondary" onClick={() => navigate(links.grading)}>
                <ClipboardCheck /> {t("eval.grading")}
              </Button>
            ) : null}
            <Menu
              label={t("common.actions")}
              items={[
                ...(isGraded(evaluation.state)
                  ? [
                      {
                        label: t("eval.results"),
                        icon: BarChart3,
                        onSelect: () => navigate(links.results),
                      },
                    ]
                  : []),
                {
                  label: t("eval.dashboard"),
                  icon: MonitorPlay,
                  onSelect: () => navigate({ view: "live", id }),
                },
                {
                  label: t("eval.duplicate"),
                  icon: Copy,
                  onSelect: () =>
                    duplicate.mutate(t("eval.duplicateTitle", { title: evaluation.title })),
                },
                /*
                 * The teacher's own test attempt, thrown away so the walk can
                 * be done again (ADR-018). It only exists when there is one,
                 * and it lives in the overflow beside the other destructive
                 * item rather than as a fourth button in the header: the
                 * action tiers of DESIGN.md allow three secondaries, and the
                 * red of a destructive action belongs to the dialog it opens.
                 */
                ...(self.attemptId !== null && self.staffSeat
                  ? [
                      {
                        label: t("eval.resetAttempt"),
                        icon: RotateCcw,
                        danger: true,
                        separator: true,
                        onSelect: async () => {
                          if (
                            await confirm({
                              title: t("eval.resetAttempt.title"),
                              message: t("eval.resetAttempt.message"),
                              confirmLabel: t("eval.resetAttempt.confirm"),
                              cancelLabel: t("common.cancel"),
                              danger: true,
                            })
                          ) {
                            resetAttempt.mutate();
                          }
                        },
                      },
                    ]
                  : []),
                {
                  label: t("eval.delete"),
                  icon: Trash2,
                  danger: true,
                  separator: self.attemptId === null || !self.staffSeat,
                  onSelect: async () => {
                    if (
                      await confirm({
                        title: t("eval.deleteConfirm", { name: evaluation.title }),
                        confirmLabel: t("common.delete"),
                        cancelLabel: t("common.cancel"),
                        danger: true,
                      })
                    ) {
                      remove.mutate(evaluation.title);
                    }
                  },
                },
              ]}
            />
          </>
        }
      />

      <Tabs
        value={step}
        onChange={(v) => setStep(v)}
        label={t("eval.step.of", { n: 3 })}
        idPrefix="eval-step"
        items={[
          { value: "questions", label: t("eval.step.questions"), count: data.items.length },
          { value: "timing", label: t("eval.step.timing") },
          { value: "launch", label: t("eval.step.launch") },
        ]}
      />

      <FormError error={remove.error} title={t("eval.saveFailed")} />

      <TabPanel idPrefix="eval-step" value={step}>
        {step === "questions" ? (
          <ItemsStep detail={data} />
        ) : step === "timing" ? (
          <TimingStep detail={data} patch={patch} showMissing={timingChecked} />
        ) : (
          <LaunchStep detail={data} navigate={navigate} />
        )}
      </TabPanel>

      {/*
       * The two buttons NAME the step they lead to. "Next" and "Back" said
       * only that there was one more screen; a teacher who came back to a
       * half-configured quiz had to read the tab strip to find out which. The
       * forward one is the primary of the step frame and the backward one is
       * always secondary — on Launch the primary belongs to the launch action
       * itself, so the frame keeps only the way back.
       */}
      <div className={cx("flex gap-2", step === "questions" ? "justify-end" : "justify-between")}>
        {step === "questions" ? null : (
          <Button
            variant="secondary"
            onClick={() => setStep(step === "timing" ? "questions" : "timing")}
          >
            <ArrowLeft />
            {step === "timing" ? t("eval.backTo.questions") : t("eval.backTo.timing")}
          </Button>
        )}
        {step === "launch" ? null : (
          <Button onClick={() => (step === "questions" ? setStep("timing") : goToLaunch())}>
            {step === "questions" ? t("eval.goTo.timing") : t("eval.goTo.launch")}
            <ArrowRight />
          </Button>
        )}
      </div>

    </div>
  );
}
