import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, ClipboardCheck, Copy, Eye, MonitorPlay, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import type { ClassroomDetail, EvaluationDetail } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { gradingLinks } from "../grading";
import { useT } from "../i18n";
import type { Route } from "../router";
import { useSearchParam } from "../router";
import {
  Alert,
  Badge,
  Button,
  Field,
  Menu,
  Modal,
  PageError,
  PageHeader,
  Skeleton,
  TabPanel,
  Tabs,
} from "../ui";
import { evaluationKey, evaluationsKey, isGraded, stateLabel, stateTone } from "./common";
import { ItemsStep } from "./ItemsStep";
import { LaunchStep } from "./LaunchStep";
import { PreviewSheet } from "./PreviewSheet";
import { TimingStep } from "./TimingStep";
import { useEvaluationPatch } from "./usePatch";

/**
 * The three-screen configuration of docs/spec/08 §8.2: choose the questions,
 * set the time, start. They are tabs and not a wizard with a locked order — a
 * teacher preparing next week's quiz opens it six times and lands on the step
 * they left, which a wizard would make them walk through again. The step
 * lives in `?step=`, so that reload keeps it and a link can point at it.
 *
 * The one primary action belongs to the STEP, never to the page frame: "Add
 * questions" on the first, a preset on the second, "Open the waiting room" on
 * the third. The header therefore holds no primary at all, only the preview
 * and the overflow menu.
 */

const STEPS = ["questions", "timing", "launch"] as const;
type Step = (typeof STEPS)[number];

function isStep(value: string): value is Step {
  return (STEPS as readonly string[]).includes(value);
}

function RenameModal({
  detail,
  onClose,
}: {
  detail: EvaluationDetail;
  onClose: () => void;
}) {
  const t = useT();
  const patch = useEvaluationPatch(detail.evaluation.id);
  const [title, setTitle] = useState(detail.evaluation.title);
  return (
    <Modal
      title={t("eval.rename")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            loading={patch.isPending}
            disabled={title.trim() === ""}
            onClick={() => patch.mutate({ title: title.trim() }, { onSuccess: onClose })}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <Field
        label={t("eval.titleLabel")}
        required
        fullWidth
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
    </Modal>
  );
}

export function EvaluationConfig({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [rawStep, setStep] = useSearchParam("step", "questions");
  const step: Step = isStep(rawStep) ? rawStep : "questions";
  const [previewing, setPreviewing] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const detail = useQuery<EvaluationDetail>({
    queryKey: evaluationKey(id),
    queryFn: () => api(`/app/api/evaluations/${id}`),
  });
  const patch = useEvaluationPatch(id);
  const classroomId = detail.data?.evaluation.classroomId ?? null;
  const classroom = useQuery<ClassroomDetail>({
    queryKey: ["classroom", classroomId],
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
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-9 w-80" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
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

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          classroomId ? (
            <button
              type="button"
              onClick={() => navigate({ view: "classroom", id: classroomId })}
              className="hover:text-fg hover:underline"
            >
              {classroom.data
                ? `${classroom.data.course.code} — ${classroom.data.name}`
                : t("eval.title")}
            </button>
          ) : null
        }
        title={
          <span className="flex flex-wrap items-baseline gap-3">
            {evaluation.title}
            <Badge tone={stateTone(evaluation.state)}>{stateLabel(evaluation.state, t)}</Badge>
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
            <Button variant="secondary" onClick={() => setPreviewing(true)}>
              <Eye /> {t("eval.preview")}
            </Button>
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
                { label: t("eval.rename"), icon: Pencil, onSelect: () => setRenaming(true) },
                {
                  label: t("eval.duplicate"),
                  icon: Copy,
                  onSelect: () =>
                    duplicate.mutate(t("eval.duplicateTitle", { title: evaluation.title })),
                },
                {
                  label: t("eval.delete"),
                  icon: Trash2,
                  danger: true,
                  separator: true,
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

      {remove.isError ? (
        <Alert tone="danger" title={t("eval.saveFailed")}>
          {apiErrorMessage(remove.error, t("error.server"))}
        </Alert>
      ) : null}

      <TabPanel idPrefix="eval-step" value={step}>
        {step === "questions" ? (
          <ItemsStep detail={data} />
        ) : step === "timing" ? (
          <TimingStep detail={data} patch={patch} />
        ) : (
          <LaunchStep detail={data} navigate={navigate} />
        )}
      </TabPanel>

      {step !== "launch" ? (
        <div className="flex justify-end">
          <Button
            variant="secondary"
            onClick={() => setStep(step === "questions" ? "timing" : "launch")}
          >
            {t("eval.next")}
          </Button>
        </div>
      ) : null}

      {previewing ? (
        <PreviewSheet evaluationId={id} onClose={() => setPreviewing(false)} />
      ) : null}
      {renaming ? <RenameModal detail={data} onClose={() => setRenaming(false)} /> : null}
    </div>
  );
}
