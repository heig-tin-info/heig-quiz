/**
 * "Past series" on the student's home (ADR-122): the exercises of the
 * student's classrooms that are over and still open to practice.
 *
 * A practice attempt counts for nothing: the official result stays on the
 * Grades page. Each row says when the exercise closed and what the latest
 * practice scored — points, never a grade, and none under the feedback
 * policy `none` (the server sends `null`) — and carries one quiet action:
 * Practise, Practise again, or Resume an attempt still open. The title opens
 * the latest practice's results when there is one.
 *
 * The section is drawn only when it holds a row: the home's loading and
 * error states are its own, and an empty list is no news to a student.
 */
import { RotateCcw, Timer, Trophy } from "lucide-react";

import type { PracticeCard } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { feedbackLink } from "../grading";
import { useT } from "../i18n";
import type { Route } from "../router";
import { MetaItem, SectionHeading, isoDateParts } from "../ui";
import { ActivityRow, type RowAction } from "./ActivityRow";

export function PastSeries({ cards, navigate }: { cards: readonly PracticeCard[]; navigate: (r: Route) => void }) {
  const t = useT();
  if (cards.length === 0) return null;
  return (
    <section className="space-y-3">
      <SectionHeading title={t("practice.section")} />
      {cards.map((card) => (
        <PracticeRow key={card.id} card={card} navigate={navigate} />
      ))}
    </section>
  );
}

function PracticeRow({ card, navigate }: { card: PracticeCard; navigate: (r: Route) => void }) {
  const t = useT();
  const practise = () => navigate({ view: "attempt", evaluationId: card.id, practice: true });
  const action: RowAction = {
    label:
      card.openAttemptId !== null
        ? t("shome.resume")
        : card.count > 0
          ? t("practice.again")
          : t("practice.start"),
    onClick: practise,
  };
  const last = card.last;
  const results = last === null ? null : feedbackLink(last.attemptId);
  return (
    <ActivityRow
      kind={{ label: t("practice.kind"), icon: RotateCcw }}
      title={card.title}
      where={`${card.courseCode} · ${card.classroomName}`}
      {...(results ? { link: { href: results.path, onNavigate: () => navigate(results.route) } } : {})}
      {...(card.openAttemptId !== null ? { status: { label: t("practice.status.open"), tone: "amber" as const } } : {})}
      meta={
        <>
          {card.closedAt ? <MetaItem icon={Timer}>{t("practice.closedOn", { date: isoDateParts(card.closedAt).date })}</MetaItem> : null}
          {last?.score ? (
            <MetaItem icon={Trophy}>
              {t("practice.last", {
                points: formatPoints(last.score.points),
                total: formatPoints(last.score.totalPoints),
              })}
            </MetaItem>
          ) : null}
        </>
      }
      action={action}
    />
  );
}
