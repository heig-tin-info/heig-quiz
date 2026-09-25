import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Eye } from "lucide-react";
import { useEffect, useState } from "react";

import type { ItemPreview, ItemRow } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { itemPreviewKey } from "../queryKeys";
import { emptyAnswerOf, QuestionHost } from "../student/QuestionHost";
import { typeLabel } from "../questionTypes";
import { Alert, Card, Sheet, Skeleton } from "../ui";

/**
 * The Preview of a row of the question list (issue #127): ONE item, as a
 * student of this evaluation will see it, without leaving the page.
 *
 * Three things it is careful about:
 *   - the VERSION is the item's, the one in the row's version column — not
 *     the question's latest draft, not its latest publication. The server
 *     re-reads it from the evaluation (`GET …/preview/items/:itemId`);
 *   - the payload comes out of `studentView` on the server (invariant 4), and
 *     it is mounted through the player's own `QuestionHost`, so what the
 *     teacher reads is the student's rendering, not a second one;
 *   - it is loaded through the EVALUATION: a colleague of the course previews
 *     an item whatever pool it was drawn from.
 *
 * The teacher may type in the fields — a preview one cannot touch does not
 * answer "does this read right?" — and the answer lives in this component
 * and dies with the sheet. Nothing is saved, run or graded: the whole-exam
 * preview (#75) is where an evaluation is rehearsed end to end.
 */
export function ItemPreviewSheet({
  evaluationId,
  item,
  onClose,
}: {
  evaluationId: string;
  item: ItemRow;
  onClose: () => void;
}) {
  const t = useT();
  const preview = useQuery<ItemPreview>({
    queryKey: itemPreviewKey(evaluationId, item.id, item.questionVersionId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/preview/items/${item.id}`),
    // Seed 0, a frozen version: the same view on every open.
    staleTime: Infinity,
  });

  return (
    <Sheet
      title={item.internalName}
      subtitle={t("eval.questions.preview.subtitle", {
        type: typeLabel(t, item.type),
        n: item.versionNumber,
      })}
      width="lg"
      onClose={onClose}
    >
      <div className="space-y-4">
        <Alert icon={Eye} title={t("eval.questions.preview.banner")}>
          {t("eval.questions.preview.bannerBody")}
        </Alert>
        {preview.isLoading ? (
          <Card className="space-y-3 p-5 sm:p-6">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </Card>
        ) : preview.isError || !preview.data ? (
          <Alert tone="warning" icon={AlertTriangle} title={t("question.previewFailed")}>
            {apiErrorMessage(preview.error, t("error.server"))}
          </Alert>
        ) : (
          <PreviewedItem preview={preview.data} />
        )}
      </div>
    </Sheet>
  );
}

function PreviewedItem({ preview }: { preview: ItemPreview }) {
  const t = useT();
  const [answer, setAnswer] = useState<unknown>(() =>
    emptyAnswerOf(preview.type, preview.student),
  );
  useEffect(() => setAnswer(emptyAnswerOf(preview.type, preview.student)), [preview]);
  return (
    <>
      <p className="text-right text-[13px] text-fg-muted">
        {preview.points === 1 ? t("player.point") : t("player.points", { n: preview.points })}
      </p>
      <Card className="p-5 sm:p-6">
        <QuestionHost
          type={preview.type}
          student={preview.student}
          answer={answer}
          onChange={setAnswer}
          readOnly={false}
        />
      </Card>
    </>
  );
}
