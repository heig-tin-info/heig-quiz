/**
 * An LLM's why, for the TEACHER alone (ADR-045, ADR-063 §4, open question
 * 27): the justification, the points per criterion and the model that wrote
 * them, read from a grading's details — the grading panel's, or the Try
 * tab's, where the same proposal comes back for the author's own trial.
 * Stripped from every student payload, so a student never reaches this.
 */
import { aiOf, justificationOf, type AiDetails } from "@quiz/contracts";
import { formatPoints, LLM_MODELS } from "@quiz/domain";

import { useT } from "../i18n";
import { NotePanel } from "../ui";

/** The note of a proposal a model wrote; nothing when it wrote none. */
export function AiJustification({ details }: { details: unknown }) {
  const t = useT();
  const justification = justificationOf(details);
  if (!justification) return null;
  return (
    <NotePanel tone="soft" eyebrow={t("grading.aiJustification")}>
      <p className="text-[13px] text-fg">{justification}</p>
      <AiBreakdown ai={aiOf(details)} />
    </NotePanel>
  );
}

/**
 * The rest of an AI proposal (ADR-063 §4): its points per criterion and the
 * model that wrote it (N-DATA-05), under its justification.
 */
function AiBreakdown({ ai }: { ai: AiDetails | null }) {
  const t = useT();
  if (ai === null) return null;
  const model = LLM_MODELS.find((m) => m.id === ai.model)?.label ?? ai.model;
  return (
    <>
      {ai.criteria.length > 0 ? (
        <ul className="mt-3 space-y-2" aria-label={t("grading.ai.criteria")}>
          {ai.criteria.map((c, i) => (
            <li key={i} className="text-[13px]">
              <span className="flex items-baseline justify-between gap-3">
                <span className="font-medium text-fg">{c.criterion}</span>
                <span className="shrink-0 tabular-nums text-fg-muted">
                  {formatPoints(c.points)} / {formatPoints(c.maxPoints)}
                </span>
              </span>
              <span className="block text-fg-muted">{c.comment}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-xs text-fg-faint">{t("grading.ai.model", { model })}</p>
    </>
  );
}
