/**
 * Fixing a question from the evaluation preview (ADR-018, sixth addendum).
 *
 * The teacher walks the evaluation, finds a wrong question, and must be able
 * to fix it WITHOUT losing the walk: its answers live in this tab only. So
 *   - "Edit question" opens the question's editor in ANOTHER tab — its draft,
 *     like the Edit of the evaluation's item list; the walk stays here;
 *   - once a newer version is published, the question offers "Use the new
 *     version": the item moves to it (F-EVAL-03, the item list's own route),
 *     the walk is rebuilt from ITS seed, and only that question is swapped
 *     in, its answer dropped. The other questions keep order, shuffles and
 *     answers;
 *   - where the item list is frozen (`itemListLock`), the notice says why and
 *     what is left, and offers nothing that would be refused;
 *   - an evaluation that changed otherwise under the walk (an item added,
 *     removed, or moved to another version) is graded as it is NOW, which is
 *     not what the teacher answered: the preview offers to restart.
 *
 * What the evaluation holds is its detail query, the one the configuration
 * page reads: refetched when the tab regains focus and on the refresh hints
 * a publish or an update sends, so coming back from the editor is enough.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, RefreshCw, TriangleAlert } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import {
  PreviewStartBody,
  UpdateVersions,
  type EvaluationDetail,
  type EvaluationPreview,
  type ItemRow,
} from "@quiz/contracts";
import { itemListLock } from "@quiz/domain";

import { api } from "../api";
import { currentItem } from "../attempt/playerReducer";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { evaluationKey } from "../queryKeys";
import { routeToPath } from "../router";
import type { PlayerSession } from "../student/Player";
import { Alert, Button } from "../ui";

/** Every item of the evaluation, and only those, on the version the walk shows. */
function walkMatches(items: readonly ItemRow[], versions: Record<string, number>): boolean {
  return (
    items.length === Object.keys(versions).length &&
    items.every((row) => versions[row.id] === row.versionNumber)
  );
}

export function usePreviewEdit({
  evaluationId,
  preview,
  session,
  askRestart,
}: {
  evaluationId: string;
  preview: EvaluationPreview;
  session: PlayerSession;
  /** The strip's Restart, confirmation included: answers are never dropped silently. */
  askRestart: () => Promise<void>;
}): { editButton: ReactNode; notice: ReactNode } {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  // The versions the walk shows, moved by "Use the new version" alone.
  const [versions, setVersions] = useState(preview.versions);

  const detail = useQuery<EvaluationDetail>({
    queryKey: evaluationKey(evaluationId),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}`),
  });

  const { dispatch } = session;
  const seed = preview.seed;
  const adopt = useMutation({
    mutationFn: async (itemId: string) => {
      await api(`/app/api/evaluations/${evaluationId}/items/update-versions`, {
        method: "POST",
        body: JSON.stringify(UpdateVersions.parse({ itemIds: [itemId] })),
      });
      const fresh = await api<EvaluationPreview>(`/app/api/evaluations/${evaluationId}/preview`, {
        method: "POST",
        body: JSON.stringify(PreviewStartBody.parse({ seed })),
      });
      // The detail catches up BEFORE the walk moves, so the two never
      // disagree on screen and nothing reads as "the evaluation changed".
      await qc.refetchQueries({ queryKey: evaluationKey(evaluationId) });
      return fresh;
    },
    onSuccess: (fresh, itemId) => {
      const item = fresh.view.items.find((i) => i.id === itemId);
      if (item) dispatch({ type: "replace", item });
      setVersions((current) => ({ ...current, [itemId]: fresh.versions[itemId] ?? 0 }));
    },
    onError: toastError("preview.newVersion.failed"),
  });

  const itemId = currentItem(session.state)?.id;
  const data = detail.data;
  const row = data?.items.find((r) => r.id === itemId);

  const openEditor = useCallback(() => {
    if (!row) return;
    // `noopener`, like every other `target="_blank"`; the walk stays in this tab.
    window.open(
      routeToPath({ view: "question", id: row.questionId, from: evaluationId }),
      "_blank",
      "noopener",
    );
  }, [row, evaluationId]);

  if (!data || !row) return { editButton: null, notice: null };

  const editButton = data.editableQuestionIds.includes(row.questionId) ? (
    <Button variant="ghost" size="sm" onClick={openEditor} title={t("preview.edit.hint")}>
      <Pencil /> {t("preview.edit")}
    </Button>
  ) : null;

  // While our own update is on its way, the detail may already say so.
  if (!adopt.isPending && !walkMatches(data.items, versions)) {
    return {
      editButton,
      notice: (
        <Alert
          tone="warning"
          icon={TriangleAlert}
          title={t("preview.changed.title")}
          action={
            <Button variant="secondary" size="sm" onClick={() => void askRestart()}>
              {t("preview.restart")}
            </Button>
          }
        >
          {t("preview.changed.body")}
        </Alert>
      ),
    };
  }

  const latest = row.latestVersionNumber;
  if (latest === null || latest <= row.versionNumber) return { editButton, notice: null };

  const lock = itemListLock(data.evaluation.state, data.attemptCount);
  return {
    editButton,
    notice: (
      <Alert
        icon={RefreshCw}
        title={t("preview.newVersion.title", { n: latest })}
        action={
          lock === null ? (
            <Button
              variant="secondary"
              size="sm"
              loading={adopt.isPending}
              onClick={() => adopt.mutate(row.id)}
            >
              {t("preview.newVersion.use")}
            </Button>
          ) : null
        }
      >
        {lock === null
          ? t("preview.newVersion.body", { n: row.versionNumber })
          : lock === "attempts"
            ? t("preview.newVersion.attempts")
            : t("preview.newVersion.opened")}
      </Alert>
    ),
  };
}
