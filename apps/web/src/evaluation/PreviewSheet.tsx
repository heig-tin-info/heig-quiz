import { useQuery } from "@tanstack/react-query";
import { Suspense, type ComponentType } from "react";

import type { PlayerProps } from "@quiz/core/client";
import type { AttemptView } from "@quiz/contracts";
import { questionTypeClient } from "@quiz/registry/client";

import { api } from "../api";
import { useT } from "../i18n";
import { Alert, Badge, Button, Card, QueryError, Sheet, Skeleton, Spinner } from "../ui";
import { typeLabel } from "./common";

/**
 * "Voir ce que voit l'étudiant" (docs/spec/08 §8.2), the cheap honest version.
 *
 * It does not re-implement the player: it asks the server for a REAL student
 * view (`POST /evaluations/:id/preview`, seed 0, no attempt row anywhere —
 * WP5 deviation W5-16) and hands each item to its own type's `Player` with
 * `readOnly`. What the teacher reads here therefore went through
 * `toStudent`, exactly like the student's, and there is no second code path
 * that could show them something the class will not get.
 *
 * Scrolling every question in one column rather than reproducing the zen
 * shell: the question is "did I configure the right things?", not "how does
 * the player feel?", and the player is WP9's screen.
 */
export function PreviewSheet({ evaluationId, onClose }: { evaluationId: string; onClose: () => void }) {
  const t = useT();
  const preview = useQuery<AttemptView>({
    queryKey: ["evaluation-preview", evaluationId],
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/preview`, { method: "POST" }),
    // Seed 0 and no stored state: the answer never changes between two opens.
    staleTime: Infinity,
  });

  return (
    <Sheet
      title={t("eval.preview.title")}
      subtitle={t("eval.preview.note")}
      onClose={onClose}
      width="lg"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("common.done")}
        </Button>
      }
    >
      {preview.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : preview.isError || !preview.data ? (
        <QueryError
          title={t("eval.notFound")}
          error={preview.error}
          onRetry={() => void preview.refetch()}
          retrying={preview.isFetching}
          fallback={t("error.server")}
        />
      ) : preview.data.items.length === 0 ? (
        <Alert title={t("eval.preview.empty")} />
      ) : (
        <ol className="space-y-4">
          {preview.data.items.map((item, index) => {
            const type = questionTypeClient(item.type as never);
            const Player = type.Player as ComponentType<PlayerProps<unknown, unknown>>;
            return (
              <li key={item.id}>
                <Card className="space-y-3 p-4">
                  <div className="flex flex-wrap items-center gap-2 text-[13px] text-fg-muted">
                    <span className="font-semibold text-fg">
                      {t("live.grid.question", { n: index + 1 })}
                    </span>
                    <Badge tone="zinc">{typeLabel(item.type, t)}</Badge>
                    <span className="tabular-nums">
                      {t("eval.count.points", { n: item.points })}
                    </span>
                    {item.milestone ? (
                      <Badge tone="amber">{t("eval.questions.milestone")}</Badge>
                    ) : null}
                  </div>
                  <Suspense fallback={<Spinner className="py-6" />}>
                    <Player
                      student={item.student}
                      answer={item.answer}
                      readOnly
                      onChange={() => {}}
                    />
                  </Suspense>
                </Card>
              </li>
            );
          })}
        </ol>
      )}
    </Sheet>
  );
}
