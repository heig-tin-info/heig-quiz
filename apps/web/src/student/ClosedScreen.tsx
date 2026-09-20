/**
 * The end of an attempt: time is up, handed in, or the teacher closed the
 * evaluation.
 *
 * It replaces the player rather than greying it out. Once the server refuses
 * writes (`410`, §4.7), every control on the screen is a lie, and the student
 * needs one sentence and one way out — not a form they can still type in.
 *
 * The three reasons read differently on purpose: "time is up" must say that
 * the answers WERE saved and handed in, because that is the fear.
 */
import { Clock, Lock, Send } from "lucide-react";

import type { AttemptClosed } from "@quiz/contracts";

import { useT, type Dict } from "../i18n";
import { Button, Card, EmptyState, type IconType } from "../ui";

const COPY: Record<
  AttemptClosed["reason"],
  { icon: IconType; title: keyof Dict; body: keyof Dict }
> = {
  deadline: {
    icon: Clock,
    title: "player.closed.deadline.title",
    body: "player.closed.deadline.body",
  },
  submitted: {
    icon: Send,
    title: "player.closed.submitted.title",
    body: "player.closed.submitted.body",
  },
  evaluation_closed: {
    icon: Lock,
    title: "player.closed.evaluation.title",
    body: "player.closed.evaluation.body",
  },
  // A pause is not an end; the player shows `PausedOverlay` instead. It is
  // listed so the union stays total if the server ever closes on it.
  paused: { icon: Clock, title: "player.paused.title", body: "player.paused.body" },
};

export function ClosedScreen({
  reason,
  title,
  onHome,
}: {
  reason: AttemptClosed["reason"];
  /** The evaluation's own title, so the page still says what ended. */
  title: string;
  onHome: () => void;
}) {
  const t = useT();
  const copy = COPY[reason];
  return (
    <main className="mx-auto w-full max-w-160 px-4 py-16 sm:px-6">
      <Card className="px-6 py-4">
        <EmptyState
          icon={copy.icon}
          title={t(copy.title)}
          action={
            <Button variant="primary" onClick={onHome}>
              {t("player.closed.home")}
            </Button>
          }
        >
          <span className="mb-1 block font-medium text-fg">{title}</span>
          {t(copy.body)}
        </EmptyState>
      </Card>
    </main>
  );
}
