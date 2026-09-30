import { useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";

import type { ItemPreview, ItemRow } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { itemPreviewKey } from "../queryKeys";
import type { EditTarget } from "./editTarget";
import { typeLabel } from "../questionTypes";
import { Alert, Sheet } from "../ui";
import { PreviewedQuestion } from "../question/PreviewedQuestion";

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
 *   - it is loaded through the EVALUATION (or the template, whose twin route
 *     the `target` names): a colleague of the course previews an item
 *     whatever pool it was drawn from.
 *
 * Nothing is saved, run or graded: the whole-exam preview (#75) is where an
 * evaluation is rehearsed end to end.
 */
export function ItemPreviewSheet({
  target,
  item,
  onClose,
}: {
  target: EditTarget;
  item: ItemRow;
  onClose: () => void;
}) {
  const t = useT();
  const preview = useQuery<ItemPreview>({
    queryKey: itemPreviewKey(target.detailKey, item.id, item.questionVersionId),
    queryFn: () => api(`${target.base}/preview/items/${item.id}`),
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
        <PreviewedQuestion query={preview} />
      </div>
    </Sheet>
  );
}
