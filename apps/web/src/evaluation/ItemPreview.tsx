import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eye } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import type { ItemPreview as ItemPreviewData, ItemRow, PreviewSolution } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { itemPreviewKey } from "../queryKeys";
import type { EditTarget } from "./editTarget";
import { typeLabel } from "../questionTypes";
import { Alert, ASIDE_MIN_WIDTH, IconButton, pageBox, PaneOrSheet, useMinWidth } from "../ui";
import { PreviewedQuestion } from "../question/PreviewedQuestion";

/** The docked preview's width; the page widens by it (`pageBox`), as the pool's does. */
const PANE_WIDTH = "30rem";

/**
 * Which item of the list is previewed, and whether the preview DOCKS beside
 * the list. The page that holds the list owns it, since a docked pane widens
 * the whole page (`box`), heading included; the list reads and moves it.
 */
export function useItemPane() {
  const [shown, setShown] = useState<string | null>(null);
  const docked = useMinWidth(ASIDE_MIN_WIDTH);
  return {
    shown,
    setShown,
    /** The width of the docked pane, or null when the preview is a sheet. */
    pane: docked ? PANE_WIDTH : null,
    /** The page's box: widened while a docked preview is open on `active` (its tab). */
    box: (active: boolean) => pageBox(active && shown !== null && docked ? PANE_WIDTH : null),
    /** Escape closes the preview from anywhere in the list or in it. */
    closeOnEscape: (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || shown === null) return;
      e.preventDefault();
      setShown(null);
    },
  };
}
export type ItemPane = ReturnType<typeof useItemPane>;

/**
 * The Preview of a row of the question list (issue #127): ONE item, as a
 * student of this evaluation will see it, without leaving the page. Docked
 * beside the list when the window has room (`pane`), so the list stays
 * readable and a click on another row swaps the question, like the pool's
 * reading pane; a sheet over the list otherwise. ↑ and ↓ in its header walk
 * the list.
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
export function ItemPreview({
  target,
  item,
  pane,
  onMove,
  onClose,
}: {
  target: EditTarget;
  item: ItemRow;
  pane: string | null;
  /** To the previous (-1) or next (1) item of the list; absent at its ends. */
  onMove: { prev?: () => void; next?: () => void };
  onClose: () => void;
}) {
  const t = useT();
  const key = itemPreviewKey(target.detailKey, item.id, item.questionVersionId);
  const preview = useQuery<ItemPreviewData>({
    queryKey: key,
    queryFn: () => api(`${target.base}/preview/items/${item.id}`),
    // Seed 0, a frozen version: the same view on every open.
    staleTime: Infinity,
  });

  return (
    <PaneOrSheet
      pane={pane}
      width="lg"
      title={item.internalName}
      subtitle={t("eval.questions.preview.subtitle", {
        type: typeLabel(t, item.type),
        n: item.versionNumber,
      })}
      onClose={onClose}
      actions={
        <>
          <IconButton
            label={t("eval.questions.preview.prev")}
            disabled={!onMove.prev}
            onClick={onMove.prev}
          >
            <ArrowUp />
          </IconButton>
          <IconButton
            label={t("eval.questions.preview.next")}
            disabled={!onMove.next}
            onClick={onMove.next}
          >
            <ArrowDown />
          </IconButton>
        </>
      }
    >
      <div className="space-y-4">
        <Alert icon={Eye} title={t("eval.questions.preview.banner")}>
          {t("eval.questions.preview.bannerBody")}
        </Alert>
        <PreviewedQuestion
          key={item.id}
          query={preview}
          solution={{
            queryKey: [...key, "solution"],
            queryFn: () => api<PreviewSolution>(`${target.base}/preview/items/${item.id}/solution`),
          }}
        />
      </div>
    </PaneOrSheet>
  );
}
