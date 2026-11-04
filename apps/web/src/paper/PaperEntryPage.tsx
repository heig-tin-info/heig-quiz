/**
 * `/evaluations/:id/paper/new?user=…&date=…` — a staff member types in one
 * student's paper copy (ADR-125 §9, F-PAPER-01..03).
 *
 * The screen IS the student player (`PlayerView`), driven by
 * `usePaperSession`: the questions in the order of the hand-out, each one
 * answered in the very editor a student uses, so an answer is typed in the
 * shape the server reads a student's (invariant 7). That it is a paper copy
 * is a MODE, stated by the inverted strip above everything (`ModeBanner`),
 * like the preview's. The expected answer of the question on screen is one
 * ghost button away, where the player puts the preview's tools.
 *
 * ONE primary action: "Hand in the copy", the player's own hand-in. Nothing
 * reaches the server before it; the answers wait in the tab (a
 * `sessionStorage` draft survives a reload). Once handed in, the page gives
 * way to the copy in the results, where its scan is attached.
 */
import { KeyRound, PenLine, UserX } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import type { PaperItems } from "@quiz/contracts";

import { currentItem } from "../attempt/playerReducer";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { QuestionReviewHost } from "../questionTypes";
import { useSearchParam, type Navigate } from "../router";
import { ModeBanner } from "../Shell";
import { PlayerView } from "../student/Player";
import { Alert, Button, Card, EmptyState, Modal, QueryError, Spinner } from "../ui";
import { paperRefusalOf, REFUSAL_KEYS, useEnterPaper, usePaperItems } from "./api";
import { clearPaperDraft, paperView, usePaperSession } from "./usePaperSession";

export function PaperEntryPage({ evaluationId, navigate }: { evaluationId: string; navigate: Navigate }) {
  const t = useT();
  const [user] = useSearchParam("user", "");
  const [date] = useSearchParam("date", "");
  const paper = usePaperItems(evaluationId, user);

  // Back where the copy was asked for: the live grid while the exam runs, the results after.
  const live = paper.data && ["running", "paused"].includes(paper.data.view.evaluation.state);
  const back = () => navigate(live ? { view: "live", id: evaluationId } : { view: "results", evaluationId });

  if (paper.data) {
    return (
      <PaperWalk
        key={user}
        evaluationId={evaluationId}
        paper={paper.data}
        examDate={date || paper.data.examDate}
        // The copy in the results, where its scan is attached (ADR-125 §15).
        onDone={(attemptId) =>
          void navigate({ view: "results", evaluationId }, { replace: true, query: { copy: attemptId } })
        }
        onBack={back}
      />
    );
  }
  let content: ReactNode;
  if (paper.isError || user === "") {
    const refusal = paperRefusalOf(paper.error);
    content = (
      <main className="mx-auto w-full max-w-160 px-4 py-16">
        {refusal || user === "" ? (
          <Card className="px-6 py-4">
            <EmptyState
              icon={UserX}
              titleAs="h1"
              title={t("paper.refused.title")}
              action={
                <Button variant="primary" onClick={back}>
                  {t("paper.leave")}
                </Button>
              }
            >
              {t(REFUSAL_KEYS[refusal ?? "paper_no_seat"])}
            </EmptyState>
          </Card>
        ) : (
          <QueryError title={t("paper.loading")} query={paper} />
        )}
      </main>
    );
  } else {
    content = <Spinner label={t("paper.loading")} className="py-24" />;
  }
  // No student is named before the server said whose paper it is.
  return (
    <ModeBanner icon={<PenLine />} message={t("paper.enter")}>
      {content}
    </ModeBanner>
  );
}

/** The player, driven by the paper's own session, under the paper's strip. */
function PaperWalk({
  evaluationId,
  paper,
  examDate,
  onDone,
  onBack,
}: {
  evaluationId: string;
  paper: PaperItems;
  examDate: string;
  onDone: (attemptId: string) => void;
  onBack: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const enter = useEnterPaper(evaluationId);
  const { userId, displayName: name } = paper.student;
  const enterAsync = enter.mutateAsync;
  const handIn = useCallback(
    async (answers: Record<string, unknown>) => {
      const created = await enterAsync({ userId, examDate, answers });
      clearPaperDraft(evaluationId, userId);
      toast(t("paper.done", { name }), "success");
      onDone(created.attemptId);
    },
    [enterAsync, userId, examDate, evaluationId, toast, t, name, onDone],
  );
  const session = usePaperSession({ evaluationId, userId, paper, onSubmit: handIn });
  const initial = useMemo(() => paperView(paper, {}), [paper]);
  const current = currentItem(session.state);
  const [keyOpen, setKeyOpen] = useState(false);
  const touched = Object.keys(session.state.answers).length > 0;

  // Leaving keeps the draft in the tab; only a copy with something on it asks first.
  const askLeave = async () => {
    const ok =
      !touched ||
      (await confirm({
        title: t("paper.leave.title"),
        message: t("paper.leave.message"),
        confirmLabel: t("paper.leave"),
      }));
    if (ok) onBack();
  };
  const refusal = paperRefusalOf(enter.error);

  return (
    <ModeBanner icon={<PenLine />} message={t("paper.banner", { name })}>
      <PlayerView
        initial={initial}
        session={session}
        onHome={() => void askLeave()}
        homeLabel={t("paper.leave")}
        finish={t("paper.handIn")}
        banner={
          enter.isError ? (
            <Alert tone="danger" title={t("paper.failed")}>
              {refusal ? t(REFUSAL_KEYS[refusal]) : t("error.server")}
            </Alert>
          ) : null
        }
        tools={
          current ? (
            <Button variant="ghost" size="sm" onClick={() => setKeyOpen(true)}>
              <KeyRound /> {t("paper.key")}
            </Button>
          ) : null
        }
      />
      {keyOpen && current ? (
        <Modal title={t("paper.key")} size="lg" scroll onClose={() => setKeyOpen(false)}>
          <QuestionReviewHost
            type={current.type}
            student={current.student}
            answer={session.state.answers[current.id] ?? null}
            solution={paper.solutions[current.id] ?? null}
            details={null}
            points={null}
            maxPoints={current.points}
            audience="teacher"
          />
        </Modal>
      ) : null}
    </ModeBanner>
  );
}
