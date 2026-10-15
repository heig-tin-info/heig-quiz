/**
 * The student's level on the concepts of a course (ADR-098, #599 step 9b):
 * one "Concepts" section per classroom on the drill page, a read — never a
 * "Practise this concept" button on a row (ADR-041 §6, §11). The one action
 * is the section's secondary "Revise a concept" (ADR-115 §13), drawn only
 * while revision is open to the student there; it opens its own screen.
 *
 * A row is a concept, its band and the cards the band rests on, in the
 * course's order, so the list is not a ranking. The band is a word before it
 * is a colour; "No data yet" (fewer than five reviewed cards) is a dashed
 * neutral outline, none of the scale's colours: dark is not red (#578), and
 * so is no band: amber, grey, green. The
 * server sends no number, so there is none to show. A course without a
 * concept, a failed read or a loading page draws nothing: this is a
 * secondary read under the day's one action.
 */
import type { DrillClassroom, DrillLevel } from "@quiz/contracts";
import { DRILL_CALIBRATION_MIN_N } from "@quiz/domain";
import { badge } from "@quiz/ui";
import { Tag } from "lucide-react";

import { refName } from "../concepts/names";
import { useT } from "../i18n";
import type { Route } from "../router";
import { Badge, Button, Card, SectionHeading } from "../ui";
import { useRevisionConcepts, useStudentConceptMastery } from "./api";

const LEVEL = {
  work: { label: "drill.concepts.level.work", tone: "amber" },
  getting: { label: "drill.concepts.level.getting", tone: "zinc" },
  solid: { label: "drill.concepts.level.solid", tone: "green" },
} as const satisfies Record<DrillLevel, { label: string; tone: "amber" | "zinc" | "green" }>;

export function ConceptMastery({ room, navigate }: { room: DrillClassroom; navigate: (r: Route) => void }) {
  const t = useT();
  const mastery = useStudentConceptMastery(room.classroomId);
  // Asked only for a section that is drawn: a course with declared concepts.
  const revision = useRevisionConcepts(room.classroomId, !!mastery.data?.declared);
  if (!mastery.data?.declared || mastery.data.concepts.length === 0) return null;
  return (
    <section className="space-y-3" aria-label={`${t("drill.concepts.title")} — ${room.classroomName}`}>
      <SectionHeading
        icon={Tag}
        title={t("drill.concepts.title")}
        description={`${room.classroomName} · ${room.courseCode} — ${room.courseName}`}
        actions={
          revision.data?.available ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => navigate({ view: "revise", classroomId: room.classroomId })}
            >
              {t("drill.concepts.revise")}
            </Button>
          ) : null
        }
      />
      <Card className="divide-y divide-line">
        {mastery.data.concepts.map((row) => (
          <div key={row.concept.id} className="flex items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">{refName(row.concept)}</p>
              <p className="text-xs text-fg-faint">
                {row.cards === 0
                  ? t("drill.concepts.cards.none")
                  : t(row.cards === 1 ? "drill.concepts.cards.one" : "drill.concepts.cards", { n: row.cards })}
              </p>
            </div>
            {row.level === null ? (
              <span
                title={t("drill.concepts.noData.help", { n: DRILL_CALIBRATION_MIN_N })}
                className={badge("neutral", "border border-dashed border-line-strong bg-transparent")}
              >
                {t("drill.concepts.noData")}
              </span>
            ) : (
              <Badge tone={LEVEL[row.level].tone}>{t(LEVEL[row.level].label)}</Badge>
            )}
          </div>
        ))}
      </Card>
      <p className="px-1 text-xs text-fg-faint">{t("drill.concepts.note", { n: DRILL_CALIBRATION_MIN_N })}</p>
    </section>
  );
}
