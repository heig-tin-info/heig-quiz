/**
 * Targeted revision of one concept (ADR-115, F-DRILL-08): the student picks
 * a concept of the classroom's course and practises it on purpose, in a
 * round of at most ten of their own cards — extra practice, outside the
 * schedule and the levels, which the screen says before the round starts.
 *
 * Four steps, one primary action each: pick (Start), the round (Check, then
 * Next, the card being `PracticeCard`, the daily session's own), its end
 * (Another round), and the empty round (Back to the drill). A card answered
 * wrong at its first pass comes back once, three cards later: the queue is
 * the pure rule of `@quiz/domain` (`revisionQueue`), replayed here over the
 * answers, so "Question i of n" grows with each card that comes back.
 *
 * The confidence is asked and said back, but never sent (ADR-085 as amended
 * by ADR-115 §6): the answer's body is strict. No timer is shown.
 *
 * The four decisions:
 *   - Type: the page title, then the 17 px legend of the one question asked
 *     (which concept?); the notes and the recent rounds at 13–14 px.
 *   - Color: one accent, the primary button; a picked row wears the accent's
 *     soft fill (`RadioRow`). The verdict speaks in the semantic tones.
 *   - Space: 32 between the pick and the recent rounds, 16 inside a card.
 *   - Finish: cards on the warm canvas, hairlines, no shadow.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, History, SearchX, Target } from "lucide-react";
import { useState } from "react";

import type { DrillCorrectness, RevisionAnswerResult, RevisionRound } from "@quiz/contracts";
import { revisionQueue, type RevisionAnswer, type RevisionEntry } from "@quiz/domain";

import { refName } from "../concepts/names";
import { useT } from "../i18n";
import { drillRootKey, revisionServeKey } from "../queryKeys";
import type { Route } from "../router";
import { Trail } from "../Trail";
import { Alert, Button, Card, EmptyState, isoDateParts, PageHeader, QueryError, RadioRow, SectionHeading, Skeleton } from "../ui";
import {
  answerRoundCard,
  endRound,
  serveRoundCard,
  startRound,
  useDrillClassrooms,
  useRevisionConcepts,
  useRevisionRounds,
} from "./api";
import { PracticeCard, PracticeProgress, PracticeSummary } from "./PracticeCard";

/** Where the screen is: the pick, a round running, its end, or a concept with no card. */
type Step =
  | { step: "pick" }
  | { step: "run"; round: RevisionRound }
  | { step: "done"; round: RevisionRound; answers: RevisionAnswer[] }
  | { step: "empty" };

export function RevisePage({ classroomId, navigate }: { classroomId: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [state, setState] = useState<Step>({ step: "pick" });
  const toDrill = () => navigate({ view: "drill" });
  const start = useMutation({
    mutationFn: (conceptId: string) => startRound(classroomId, conceptId),
    onSuccess: ({ round }) => setState(round ? { step: "run", round } : { step: "empty" }),
  });

  if (state.step === "run") {
    const { round } = state;
    return (
      <RevisionRun
        key={round.id}
        round={round}
        onFinish={(answers, skipped) => {
          // A card that could not be served leaves the round open: close it.
          // (A tab closed mid-round is closed by the server with the day.)
          if (skipped) void endRound(round.id).catch(() => {});
          setState({ step: "done", round, answers });
          // The day's session leaves out what a round served; the recent rounds gain this one.
          void qc.invalidateQueries({ queryKey: drillRootKey });
        }}
      />
    );
  }

  const body = () => {
    if (state.step === "done") {
      return (
        <RevisionSummary
          answers={state.answers}
          again={start.isPending}
          onAgain={() => start.mutate(state.round.concept.id)}
          onBack={toDrill}
        />
      );
    }
    if (state.step === "empty") {
      return (
        <Card>
          <EmptyState
            icon={SearchX}
            title={t("revise.empty.title")}
            action={
              <Button variant="secondary" onClick={toDrill}>
                {t("revise.back")}
              </Button>
            }
          >
            {t("revise.empty.body")}
          </EmptyState>
        </Card>
      );
    }
    return <RevisePick classroomId={classroomId} starting={start.isPending} onStart={(id) => start.mutate(id)} onBack={toDrill} />;
  };

  return (
    <div className="mx-auto max-w-180 space-y-8">
      <RevisionHeader classroomId={classroomId} navigate={navigate} />
      {start.isError ? (
        <Alert tone="danger" icon={AlertTriangle} title={t("revise.startFailed")}>
          {t("revise.startFailed.body")}
        </Alert>
      ) : null}
      {body()}
    </div>
  );
}

/** The title, under the trail Drill › the classroom. */
function RevisionHeader({ classroomId, navigate }: { classroomId: string; navigate: (r: Route) => void }) {
  const t = useT();
  const room = useDrillClassrooms().data?.find((r) => r.classroomId === classroomId);
  return (
    <PageHeader
      eyebrow={
        <Trail
          navigate={navigate}
          items={[{ label: t("nav.drill"), route: { view: "drill" } }, ...(room ? [{ label: room.classroomName }] : [])]}
        />
      }
      title={t("revise.title")}
      description={t("revise.subtitle")}
    />
  );
}

/**
 * The pick: the concepts on offer as radio rows, Start, and the two things
 * the student must know before a round (practice only; the teacher sees
 * it). Closed (the server's `available`, or nothing on offer): one neutral
 * sentence — the server decides, the page does not guess why.
 */
function RevisePick({
  classroomId,
  starting,
  onStart,
  onBack,
}: {
  classroomId: string;
  starting: boolean;
  onStart: (conceptId: string) => void;
  onBack: () => void;
}) {
  const t = useT();
  const concepts = useRevisionConcepts(classroomId);
  const [picked, setPicked] = useState<string | null>(null);

  if (concepts.isLoading) return <Skeleton className="h-64 w-full" />;
  if (concepts.isError || !concepts.data) return <QueryError title={t("revise.loadFailed")} query={concepts} />;

  const offered = concepts.data.concepts;
  if (!concepts.data.available || offered.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Target}
          title={t("revise.unavailable")}
          action={
            <Button variant="secondary" onClick={onBack}>
              {t("revise.back")}
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <>
      <Card className="space-y-4 p-5 sm:p-6">
        <fieldset className="space-y-3">
          <legend className="text-[17px] font-bold leading-snug tracking-tight">{t("revise.pick.legend")}</legend>
          <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {offered.map((c) => (
              <RadioRow key={c.id} name="revise-concept" value={c.id} checked={picked === c.id} disabled={starting} onPick={setPicked}>
                <span className="font-semibold">{refName(c)}</span>
              </RadioRow>
            ))}
          </div>
        </fieldset>
        <ul className="space-y-1 text-[13px] text-fg-muted">
          <li>{t("revise.note.practice")}</li>
          <li>{t("revise.note.teacher")}</li>
        </ul>
        <div className="flex justify-end">
          <Button disabled={picked === null} loading={starting} onClick={() => picked && onStart(picked)}>
            {t("revise.start")}
          </Button>
        </div>
      </Card>
      <RecentRounds classroomId={classroomId} />
    </>
  );
}

/** The student's last rounds here: the concept, the day, the first-pass score. */
function RecentRounds({ classroomId }: { classroomId: string }) {
  const t = useT();
  const rounds = useRevisionRounds(classroomId);
  if (rounds.isLoading) return <Skeleton className="h-24 w-full" />;
  if (rounds.isError || !rounds.data) return <QueryError title={t("revise.recent.loadFailed")} query={rounds} />;
  if (rounds.data.length === 0) return null;
  return (
    <section className="space-y-3">
      <SectionHeading icon={History} title={t("revise.recent.title")} />
      <Card className="divide-y divide-line">
        {rounds.data.slice(0, RECENT_ROUNDS).map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className={r.concept ? "truncate text-sm font-semibold" : "truncate text-sm italic text-fg-muted"}>
                {r.concept ? refName(r.concept) : t("revise.recent.removed")}
              </p>
              <p className="text-xs text-fg-faint">{isoDateParts(r.startedAt).date}</p>
            </div>
            <p className="shrink-0 text-sm tabular-nums text-fg-muted">
              {t("revise.recent.row", { right: r.cardsCorrect, total: r.cardsServed })}
            </p>
          </div>
        ))}
      </Card>
    </section>
  );
}

/** The recent rounds shown: a semester of daily rounds would bury the pick. */
const RECENT_ROUNDS = 10;

const entryKey = (e: RevisionEntry) => `${e.cardId}:${e.pass}`;

/**
 * One round, card after card, in the order the server fixed, a wrong first
 * pass coming back once. A card that cannot be served is skipped (its pass
 * leaves the queue, nothing is requeued).
 */
function RevisionRun({
  round,
  onFinish,
}: {
  round: RevisionRound;
  onFinish: (answers: RevisionAnswer[], skipped: boolean) => void;
}) {
  const t = useT();
  const order = round.cards.map((c) => c.id);
  /** The passes behind, in the order they were done; `correctness` null for a skipped one. */
  const [behind, setBehind] = useState<(RevisionEntry & { correctness: DrillCorrectness | null })[]>([]);
  const answersOf = (done: typeof behind) =>
    done.filter((d): d is RevisionAnswer => d.correctness !== null);
  const queueOf = (done: typeof behind) => {
    const skipped = new Set(done.filter((d) => d.correctness === null).map(entryKey));
    return revisionQueue({ order, answers: answersOf(done) }).filter((e) => !skipped.has(entryKey(e)));
  };

  const queue = queueOf(behind);
  const entry = queue[0]!;
  const card = round.cards.find((c) => c.id === entry.cardId)!;
  const pass = (correctness: DrillCorrectness | null) => [...behind, { ...entry, correctness }];
  const advance = (correctness: DrillCorrectness | null) => {
    const done = pass(correctness);
    if (queueOf(done).length === 0) onFinish(answersOf(done), done.some((d) => d.correctness === null));
    else setBehind(done);
  };

  return (
    <div className="mx-auto max-w-180 space-y-6">
      <PracticeProgress
        index={behind.length}
        isNew={card.isNew}
        aside={refName(round.concept)}
        segments={[
          ...behind.map((d) => ({ id: entryKey(d), mark: "answered" as const })),
          ...queue.map((e, i) => ({ id: entryKey(e), mark: "unanswered" as const, current: i === 0 })),
        ]}
      />
      <PracticeCard<RevisionAnswerResult>
        key={entryKey(entry)}
        serveKey={revisionServeKey(round.id, card.id, entry.pass)}
        serve={() => serveRoundCard(round.id, card.id)}
        // The confidence stays here: the body is strict (ADR-115 §6).
        answer={(answer) => answerRoundCard(round.id, card.id, answer)}
        line={(result) =>
          t(result.requeued ? "revise.result.requeued" : "revise.result")
        }
        finishes={(result) => queueOf(pass(result.correctness)).length === 0}
        onNext={(result) => advance(result.correctness)}
        onSkip={() => advance(null)}
      />
    </div>
  );
}

/** The end of a round: its first-pass score, Another round, and the way back. */
function RevisionSummary({
  answers,
  again,
  onAgain,
  onBack,
}: {
  answers: RevisionAnswer[];
  again: boolean;
  onAgain: () => void;
  onBack: () => void;
}) {
  const t = useT();
  // The round's counters, as the server keeps them: first passes only.
  const first = answers.filter((a) => a.pass === 1);
  const right = first.filter((a) => a.correctness === "right").length;
  return (
    <PracticeSummary
      title={t("revise.done.title")}
      body={t("revise.done.body", { right, total: first.length })}
      actions={
        <>
          <Button variant="secondary" onClick={onBack}>
            {t("revise.back")}
          </Button>
          <Button loading={again} onClick={onAgain}>
            {t("revise.again")}
          </Button>
        </>
      }
    />
  );
}
