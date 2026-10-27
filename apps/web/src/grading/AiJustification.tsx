/**
 * An LLM's why, for the TEACHER alone (ADR-045, ADR-063 §4, open question
 * 27): the justification, the points per criterion and the model that wrote
 * them, read from a grading's details — the grading panel's, or the Try
 * tab's, where the same proposal comes back for the author's own trial.
 * Stripped from every student payload, so a student never reaches this.
 */
import { aiOf, breakdownOf, justificationOf, type AiDetails } from "@quiz/contracts";
import { LLM_MODELS } from "@quiz/domain";

import { useT } from "../i18n";
import { NotePanel } from "../ui";
import { PointsByCriterion } from "./PointsByCriterion";

/** The note of a proposal a model wrote; nothing when it wrote none. */
export function AiJustification({ details }: { details: unknown }) {
  const t = useT();
  const justification = justificationOf(details);
  if (!justification) return null;
  return (
    <NotePanel tone="soft" eyebrow={t("grading.aiJustification")}>
      <p className="text-[13px] text-fg">{justification}</p>
      {/* Once validated, the split is the validated one, shown beside (ADR-118 §6). */}
      <AiBreakdown ai={aiOf(details)} split={breakdownOf(details) === null} />
    </NotePanel>
  );
}

/**
 * The rest of an AI proposal (ADR-063 §4): its points per criterion, unless
 * `split` is off, and the model that wrote it (N-DATA-05), under its
 * justification.
 */
function AiBreakdown({ ai, split }: { ai: AiDetails | null; split: boolean }) {
  const t = useT();
  if (ai === null) return null;
  const model = LLM_MODELS.find((m) => m.id === ai.model)?.label ?? ai.model;
  return (
    <>
      {split && ai.criteria.length > 0 ? (
        <div className="mt-3">
          <PointsByCriterion
            label={t("grading.ai.criteria")}
            lines={ai.criteria.map((c, i) => ({
              key: c.id ?? String(i),
              title: c.criterion,
              points: c.points,
              maxPoints: c.maxPoints,
              note: c.comment,
            }))}
          />
        </div>
      ) : null}
      <p className="mt-3 text-xs text-fg-faint">{t("grading.ai.model", { model })}</p>
    </>
  );
}
