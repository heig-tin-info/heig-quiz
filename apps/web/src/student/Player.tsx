/**
 * The "zen" player: one question per screen (F-EVAL-08, mockup 07).
 *
 * The single primary action is "Mark as done". Everything else is one tier
 * below: previous / next are secondary, handing in is a secondary button in
 * the bar (its confirmation is where the weight belongs), and the progress
 * strip is navigation, not an action.
 *
 * What this component owns, beyond the layout:
 *   - the keyboard: `Alt + ←/→` moves, `Ctrl + Enter` marks the question as
 *     done. Alt and Ctrl, not bare arrows: every question type has a field,
 *     and a player that steals the arrow keys cannot be used to write;
 *   - the navigation rules, mirrored from the server (`playerReducer`), so a
 *     student is never offered a move the API would refuse with `409`;
 *   - the milestone confirmation of F-LIVE-08, which is the only
 *     irreversible thing on the screen.
 *
 * It never decides that the attempt is over: `useAttempt` does, from a `410`
 * or from an `attempt.closed` frame, and then this renders `ClosedScreen`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Check } from "lucide-react";

import type { AttemptView } from "@quiz/contracts";
import { questionTypeClient } from "@quiz/registry/client";

import { useAttempt } from "../attempt/useAttempt";
import { currentItem, isLocked, neighbour, type PlayerItem, type PlayerState } from "../attempt/playerReducer";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Badge, Button, Card, type Segment } from "../ui";
import { ClosedScreen } from "./ClosedScreen";
import { OfflineBanner } from "./OfflineBanner";
import { PausedOverlay } from "./PausedOverlay";
import { PlayerShell } from "./PlayerShell";
import { QuestionHost } from "./QuestionHost";
import { SubmitDialog } from "./SubmitDialog";

/** "Has something been written here?" is the question TYPE's call, not ours. */
function isAnswered(item: PlayerItem, answer: unknown): boolean {
  try {
    return questionTypeClient(item.type).isAnswered(answer ?? null);
  } catch {
    return answer !== null && answer !== undefined;
  }
}

function segmentsOf(state: PlayerState): Segment[] {
  return state.items.map((item, index) => ({
    id: item.id,
    state:
      index === state.index
        ? "current"
        : item.markedDone
          ? "done"
          : isAnswered(item, state.answers[item.id] ?? null)
            ? "answered"
            : "empty",
  }));
}

export function Player({ initial, onHome }: { initial: AttemptView; onHome: () => void }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const attempt = useAttempt(initial.attempt.id, initial);
  const { state, dispatch, sync, now, deadlineAt, closed, paused, setAnswer, markDone, submit, run } =
    attempt;
  const [submitting, setSubmitting] = useState(false);
  const item = currentItem(state);
  const total = state.items.length;
  const locked = item ? isLocked(state, item.id) : true;
  const readOnly = locked || closed !== null || paused;
  const segments = useMemo(() => segmentsOf(state), [state]);
  const unanswered = state.items.filter(
    (i) => !isAnswered(i, state.answers[i.id] ?? null),
  ).length;

  const toggleDone = useCallback(async () => {
    if (!item || closed !== null || paused) return;
    const next = !item.markedDone;
    // F-LIVE-08: crossing a milestone closes everything behind it, so it is
    // the one move that asks first.
    if (next && state.navigation === "milestones" && item.milestone) {
      const ok = await confirm({
        title: t("player.markDone"),
        message: t("lobby.nav.milestones.body"),
        confirmLabel: t("player.markDone"),
      });
      if (!ok) return;
    }
    try {
      await markDone(item.id, next);
    } catch {
      toast(t("player.doneFailed"), "error");
    }
  }, [item, closed, paused, state.navigation, confirm, t, markDone, toast]);

  // The two shortcuts of the DoD. `Alt` and `Ctrl` are held on purpose: the
  // bare keys belong to whatever field the student is typing in.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (submitting) return;
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        dispatch({ type: "move", delta: e.key === "ArrowRight" ? 1 : -1 });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void toggleDone();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, toggleDone, submitting]);

  if (closed !== null) {
    return <ClosedScreen reason={closed.reason} title={initial.evaluation.title} onHome={onHome} />;
  }

  const previous = neighbour(state, -1);
  const next = neighbour(state, 1);
  const hint = locked
    ? t("player.hint.locked")
    : state.navigation === "free"
      ? t("player.hint.saving")
      : t("player.hint.forward");

  return (
    <>
      <PlayerShell
        title={initial.evaluation.title}
        deadlineAt={deadlineAt}
        now={now}
        sync={sync}
        segments={segments}
        onSelectSegment={(itemId) => dispatch({ type: "goto", itemId })}
        progressLabel={t("player.progress", { n: state.index + 1, total })}
        headerAction={
          <Button variant="secondary" size="sm" onClick={() => setSubmitting(true)}>
            {t("player.finish")}
          </Button>
        }
        banner={<OfflineBanner show={sync === "offline"} />}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => dispatch({ type: "move", delta: -1 })}
              disabled={previous === null}
            >
              <ChevronLeft className="size-4" aria-hidden />
              {t("player.prev")}
            </Button>
            <div className="flex-1" />
            <Button
              variant={item?.markedDone ? "secondary" : "primary"}
              onClick={() => void toggleDone()}
              // A locked question cannot be un-marked: the server answers
              // `409 irreversible`, so the button must not offer it.
              disabled={readOnly}
            >
              {item?.markedDone ? <Check className="size-4" aria-hidden /> : null}
              {item?.markedDone ? t("player.markedDone") : t("player.markDone")}
            </Button>
            <div className="flex-1" />
            <Button
              variant="secondary"
              onClick={() => dispatch({ type: "move", delta: 1 })}
              disabled={next === null}
            >
              {t("player.next")}
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          </>
        }
      >
        {item ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-[13px] font-semibold uppercase tracking-wide text-fg-faint">
                {t("player.question", { n: state.index + 1, total })}
              </h1>
              <span className="text-[13px] text-fg-faint">
                {item.points === 1 ? t("player.point") : t("player.points", { n: item.points })}
              </span>
              {item.markedDone ? (
                <Badge tone="green" icon={Check}>
                  {t("player.markedDone")}
                </Badge>
              ) : null}
            </div>
            <Card className="p-5 sm:p-6">
              <QuestionHost
                key={item.id}
                type={item.type}
                student={item.student}
                answer={state.answers[item.id] ?? null}
                onChange={(payload) => setAnswer(item.id, payload)}
                readOnly={readOnly}
                {...(item.type === "code"
                  ? {
                      onRun: (answer: unknown) =>
                        run(item.id, (answer as { regions?: string[] }).regions ?? []),
                    }
                  : {})}
              />
            </Card>
            <p className="mt-3 text-[13px] leading-relaxed text-fg-faint">{hint}</p>
          </>
        ) : null}
      </PlayerShell>
      <PausedOverlay show={paused} />
      <SubmitDialog
        open={submitting}
        unanswered={unanswered}
        onCancel={() => setSubmitting(false)}
        onConfirm={async () => {
          try {
            await submit();
          } catch {
            toast(t("player.submitFailed"), "error");
          } finally {
            setSubmitting(false);
          }
        }}
      />
    </>
  );
}
