/**
 * `/evaluations/:id/preview` — the teacher walks the whole evaluation as a
 * student would, and gets the full correction at the end (issue #75, ADR-018
 * fourth addendum). Opened in a new tab from the evaluation page, so the
 * configuration stays where it was and can be edited meanwhile.
 *
 * It is stateless, and it says so: the server draws a seed and hands back
 * the student's view of it; the answers stay in this tab; "Hand in" (or the
 * countdown reaching zero) sends every answer with the seed to one grading
 * call, and nothing is stored anywhere. "Restart" draws a new seed — a new
 * order, new shuffles, an empty paper.
 *
 * The screen during the walk IS the student player (`PlayerView`), driven by
 * `usePreviewSession` instead of `useAttempt`, with one addition: the preview
 * banner above the question. The four decisions are therefore the player's;
 * the banner is the calm `neutral` alert, and its one action, Restart, is
 * secondary — the accent stays on "Hand in".
 *
 * The start is a MUTATION, not a query, on purpose: the app's refresh hints
 * invalidate every query, and a query here would draw a new seed — and throw
 * the teacher's answers away — whenever a colleague saved something.
 */
import { useMutation } from "@tanstack/react-query";
import { Eye, Loader2, RotateCcw, UserX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  PreviewGradeBody,
  type EvaluationPreview,
  type PreviewCorrection,
} from "@quiz/contracts";

import { ApiError, api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import type { Route } from "../router";
import { PlayerView } from "../student/Player";
import { Alert, Button, Card, EmptyState, QueryError, Spinner } from "../ui";
import { PreviewCorrectionView } from "./PreviewCorrection";
import { usePreviewSession } from "./usePreviewSession";

interface Walk {
  preview: EvaluationPreview;
  /** Epoch ms of the moment the preview arrived: the countdown starts there. */
  startedAt: number;
}

export function EvaluationPreviewPage({
  id,
  navigate,
}: {
  id: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const [walk, setWalk] = useState<Walk | null>(null);
  const [correction, setCorrection] = useState<PreviewCorrection | null>(null);
  /*
   * Our own flag rather than `start.isPending`: the mutation is fired from a
   * mount effect, and under StrictMode the observer that is left after the
   * double mount never sees that first call settle — the button stayed
   * disabled for good.
   */
  const [restarting, setRestarting] = useState(false);

  const start = useMutation({
    mutationFn: () =>
      api<EvaluationPreview>(`/app/api/evaluations/${id}/preview`, { method: "POST" }),
    onSuccess: (preview) => {
      setCorrection(null);
      setWalk({ preview, startedAt: Date.now() });
    },
    onSettled: () => setRestarting(false),
  });
  const startPreview = start.mutate;
  // Once per mount: StrictMode mounts twice, and two seeds would be two
  // previews for one click.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    startPreview();
  }, [startPreview]);

  const grade = useMutation({
    mutationFn: (input: { seed: number; answers: Record<string, unknown> }) =>
      api<PreviewCorrection>(`/app/api/evaluations/${id}/preview/grade`, {
        method: "POST",
        body: JSON.stringify(PreviewGradeBody.parse(input)),
      }),
    onSuccess: setCorrection,
  });
  const gradeAsync = grade.mutateAsync;
  const seed = walk?.preview.seed ?? null;
  const handIn = useCallback(
    async (answers: Record<string, unknown>) => {
      if (seed === null) return;
      await gradeAsync({ seed, answers });
    },
    [gradeAsync, seed],
  );

  const back = () => navigate({ view: "evaluation", id });
  const restart = () => {
    setRestarting(true);
    grade.reset();
    startPreview();
  };

  if (correction && walk) {
    return (
      <PreviewCorrectionView
        title={walk.preview.view.evaluation.title}
        correction={correction}
        restarting={restarting}
        onRestart={restart}
        onBack={back}
      />
    );
  }

  if (walk) {
    return (
      <PreviewWalk
        // A new seed is a new paper: nothing of the previous walk survives.
        key={walk.preview.seed}
        evaluationId={id}
        walk={walk}
        grading={grade.isPending}
        gradeFailed={grade.isError}
        restarting={restarting}
        onHandIn={handIn}
        onRestart={restart}
        onBack={back}
      />
    );
  }

  if (start.isError) {
    const missing = start.error instanceof ApiError && start.error.status === 404;
    return (
      <main className="mx-auto w-full max-w-160 px-4 py-16">
        {missing ? (
          <Card className="px-6 py-4">
            <EmptyState
              icon={UserX}
              titleAs="h1"
              title={t("preview.notFound")}
              action={
                <Button variant="primary" onClick={() => navigate({ view: "home" })}>
                  {t("player.closed.home")}
                </Button>
              }
            />
          </Card>
        ) : (
          <QueryError
            title={t("preview.startFailed")}
            error={start.error}
            onRetry={() => startPreview()}
            retrying={start.isPending}
          />
        )}
      </main>
    );
  }

  return <Spinner label={t("preview.starting")} className="py-24" />;
}

/** The player, driven by the preview's own session, under the preview banner. */
function PreviewWalk({
  evaluationId,
  walk,
  grading,
  gradeFailed,
  restarting,
  onHandIn,
  onRestart,
  onBack,
}: {
  evaluationId: string;
  walk: Walk;
  grading: boolean;
  gradeFailed: boolean;
  restarting: boolean;
  onHandIn: (answers: Record<string, unknown>) => Promise<void>;
  onRestart: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const confirm = useConfirm();
  const session = usePreviewSession({
    evaluationId,
    preview: walk.preview,
    startedAt: walk.startedAt,
    onSubmit: onHandIn,
  });
  const touched = Object.keys(session.state.answers).length > 0;

  const askRestart = async () => {
    // Only a paper with something on it has something to lose.
    if (
      touched &&
      !(await confirm({
        title: t("preview.restart.title"),
        message: t("preview.restart.message"),
        confirmLabel: t("preview.restart"),
        cancelLabel: t("common.cancel"),
      }))
    ) {
      return;
    }
    onRestart();
  };

  return (
    <>
      <PlayerView
        initial={walk.preview.view}
        session={session}
        onHome={onBack}
        banner={
          <div className="space-y-3">
            <Alert
              icon={Eye}
              title={t("preview.banner")}
              action={
                <Button variant="secondary" size="sm" onClick={() => void askRestart()} disabled={restarting}>
                  <RotateCcw /> {t("preview.restart")}
                </Button>
              }
            >
              {t("preview.bannerBody")}
            </Alert>
            {gradeFailed ? (
              <Alert tone="danger" title={t("preview.gradeFailed")}>
                {t("preview.gradeFailedBody")}
              </Alert>
            ) : null}
            {walk.preview.view.items.length === 0 ? (
              <Card className="px-6 py-4">
                <EmptyState icon={Eye} title={t("preview.empty.title")}>
                  {t("preview.empty.body")}
                </EmptyState>
              </Card>
            ) : null}
          </div>
        }
      />
      {grading ? <GradingOverlay /> : null}
    </>
  );
}

/**
 * While the grading runs — the runner may take seconds per code question —
 * the paper is covered, not unmounted: a grading that fails hands the
 * teacher back the answers they wrote.
 */
function GradingOverlay() {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-40 flex items-center justify-center bg-canvas/85 px-4 backdrop-blur-[2px]"
    >
      <div className="w-full max-w-115 rounded-card border border-line bg-surface px-6 py-8 text-center">
        <Loader2 className="mx-auto size-6 animate-spin text-fg-faint" aria-hidden />
        <h2 className="mt-4 text-lg font-bold tracking-tight">{t("preview.grading.title")}</h2>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">{t("preview.grading.body")}</p>
      </div>
    </div>
  );
}
