/**
 * "Show the points" in the evaluation preview: the teacher grades the
 * question on screen, with the answer as it stands, without handing the
 * paper in — to check that the key, the partial credit and the negative
 * marking (ADR-026) do what they meant before a student meets them.
 *
 * It is the preview's own grading call (`POST /preview/grade`), sent with
 * the one answer of the question on screen: the server grades it exactly as
 * it grades a hand-in, the evaluation's policies included, and stores
 * nothing. The points answer ONE answer: once it changes, or the teacher
 * moves to another question, they are stale and the button comes back.
 */
import { useMutation } from "@tanstack/react-query";
import { Calculator } from "lucide-react";

import { PreviewGradeBody, type PreviewCorrection, type PreviewItemStatus } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { Badge, Button } from "../ui";
import { STATUS_LABEL } from "./PreviewCorrection";

interface Graded {
  itemId: string;
  /** The answer the points were computed for, compared by reference. */
  answer: unknown;
  correction: PreviewCorrection;
}

export function PreviewPoints({
  evaluationId,
  seed,
  itemId,
  answer,
}: {
  evaluationId: string;
  seed: number;
  itemId: string;
  /** `undefined` for a question never opened: it is worth zero. */
  answer: unknown;
}) {
  const t = useT();
  const grade = useMutation({
    mutationFn: async (input: { itemId: string; answer: unknown }): Promise<Graded> => {
      const answers = input.answer === undefined ? {} : { [input.itemId]: input.answer };
      const correction = await api<PreviewCorrection>(
        `/app/api/evaluations/${evaluationId}/preview/grade`,
        { method: "POST", body: JSON.stringify(PreviewGradeBody.parse({ seed, answers })) },
      );
      return { ...input, correction };
    },
  });

  const fresh =
    grade.data && grade.data.itemId === itemId && grade.data.answer === answer
      ? grade.data.correction.items.find((i) => i.itemId === itemId)
      : undefined;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => grade.mutate({ itemId, answer })}
        loading={grade.isPending}
      >
        <Calculator /> {t("preview.points.show")}
      </Button>
      {fresh ? (
        fresh.status === "graded" && fresh.points !== null ? (
          <span className="text-[13px] font-semibold tabular-nums">
            {t("preview.points.value", { points: formatPoints(fresh.points), max: fresh.maxPoints })}
          </span>
        ) : (
          <Badge tone={fresh.status === "no_key" || fresh.status === "manual" ? "zinc" : "amber"}>
            {t(STATUS_LABEL[fresh.status as Exclude<PreviewItemStatus, "graded">])}
          </Badge>
        )
      ) : grade.isError && grade.variables?.itemId === itemId && grade.variables.answer === answer ? (
        <span className="text-[13px] text-danger">
          {apiErrorMessage(grade.error, t("preview.points.failed"))}
        </span>
      ) : null}
    </div>
  );
}
