import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EvaluationDetail } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { tryAdapterFor } from "../questionTypes";
import { routeToPath, useSearchParam, type Route } from "../router";
import { PageError, PageSkeleton, TabPanel, Tabs } from "../ui";
import { PublishDialog } from "./PublishDialog";
import { QuestionEditTab } from "./QuestionEditTab";
import { QuestionHeader } from "./QuestionHeader";
import { TryPanel } from "./TryPanel";
import { useEditorShortcuts } from "./useEditorShortcuts";
import { useQuestionActions } from "./useQuestionActions";
import { useQuestionDraft } from "./useQuestionDraft";
import { VersionHistory } from "./VersionHistory";
import { evaluationKey, poolKey, questionKey } from "../queryKeys";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The evaluation the editor was opened from (`?from=`, issue #127), and its
 * title for the way back. The query is the evaluation page's own, so coming
 * from there costs no request; after a reload it costs one. Anything that is
 * not an evaluation id this reader reaches is ignored, and the header falls
 * back to the pool.
 */
function useOrigin(): { id: string; title: string } | null {
  const [from] = useSearchParam("from", "");
  const valid = UUID.test(from);
  const origin = useQuery<EvaluationDetail>({
    queryKey: evaluationKey(from),
    enabled: valid,
    queryFn: () => api(`/app/api/evaluations/${from}`),
    retry: false,
  });
  if (!valid || !origin.data) return null;
  return { id: from, title: origin.data.evaluation.title };
}

/**
 * The question editor (mockups `01-editeur-qcm.html`, `02-editeur-code.html`).
 *
 * The ONE primary action is "Publish"; everything else is secondary (the
 * student preview, which opens `/questions/:id/preview` in a tab of its own)
 * or in the overflow menu (duplicate, delete, save now).
 *
 * Three decisions shape the screen:
 *
 * - **the draft is the working copy**. It autosaves 500 ms after the last
 *   change, one request at a time, and an invalid draft is stored anyway
 *   (decision D16). The badge in the header is the answer to "did that
 *   save?", so it is never hidden.
 * - **the type owns the form**. The `Editor` of the question type is mounted
 *   lazily from the registry with the app's strings, markdown renderer and
 *   asset upload; this file knows about configs only as opaque values.
 * - **three tabs, one subject**: write it, try it, look at what was
 *   published. The tab lives in the query string, so a reload comes back to
 *   the same place.
 */

type Tab = "edit" | "try" | "versions";

export function QuestionEditor({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [rawTab, setTab] = useSearchParam("tab", "edit");
  const tab: Tab = rawTab === "try" || rawTab === "versions" ? rawTab : "edit";
  const { detail, pool, poolId, readOnly, draft, setDraft, autosave, issues, edited } =
    useQuestionDraft(id);
  const [publishing, setPublishing] = useState(false);
  const origin = useOrigin();
  // The tab panel, so `Ctrl+Enter` can put the reader inside what it opened.
  const panelRef = useRef<HTMLDivElement>(null);
  const followToPanel = useRef(false);

  const { duplicate, askDelete } = useQuestionActions(poolId, {
    onDuplicated: (copy) => navigate({ view: "question", id: copy.meta.id }),
    onDeleted: () => navigate(poolId ? { view: "pool", id: poolId } : { view: "pools" }),
  });

  const { flush } = autosave;

  /**
   * "Student preview": a TAB of its own, on `/questions/:id/preview`
   * (docs/spec/08 §8.2). It used to be a panel at the bottom of the right
   * column of the Edit tab, which is why pressing the button looked like it
   * did nothing — from the Try tab it really did nothing, and from the Edit
   * tab it opened something below the fold. The draft is flushed first, for
   * the reason the Try tab flushes it: the preview renders what the SERVER
   * holds, and previewing a question without the edit that prompted the
   * preview is the one thing this button must not do.
   *
   * `noopener`, like every other `target="_blank"`: the opened page gets no
   * handle on this one.
   */
  const openPreview = useCallback(() => {
    flush();
    window.open(routeToPath({ view: "questionPreview", id }), "_blank", "noopener");
  }, [flush, id]);

  const type = detail.data?.meta.type;
  const onTry = useMemo(
    () => (type === undefined ? undefined : tryAdapterFor(type, { id, flush })),
    [type, id, flush],
  );

  const startPublish = useCallback(() => setPublishing(true), []);
  const openTry = useCallback(() => {
    followToPanel.current = true;
    setTab("try");
  }, [setTab]);
  useEditorShortcuts({
    readOnly,
    flush,
    onPublish: startPublish,
    onPreview: openPreview,
    onTry: openTry,
  });

  useEffect(() => {
    if (!followToPanel.current) return;
    followToPanel.current = false;
    panelRef.current?.focus();
  }, [tab]);

  if (detail.isLoading) {
    return <PageSkeleton />;
  }
  if (detail.isError) {
    return (
      <PageError
        title={t("question.notFound")}
        error={detail.error}
        onRetry={() => void detail.refetch()}
        retrying={detail.isFetching}
        fallback={t("error.server")}
      />
    );
  }

  const data = detail.data!;

  return (
    <div className="space-y-6">
      <QuestionHeader
        id={id}
        data={data}
        poolName={pool.data?.pool.name}
        readOnly={readOnly}
        autosave={autosave}
        origin={origin?.title}
        onBack={() =>
          navigate(
            origin
              ? { view: "evaluation", id: origin.id }
              : { view: "pool", id: data.meta.poolId },
          )
        }
        onPublish={startPublish}
        onDuplicate={() => duplicate(data.meta)}
        onDelete={() => void askDelete(data.meta)}
      />

      <Tabs
        value={tab}
        onChange={(v) => setTab(v)}
        idPrefix="question"
        label={t("question.tabs")}
        items={[
          { value: "edit", label: t("question.tab.edit") },
          { value: "try", label: t("question.tab.try") },
          { value: "versions", label: t("question.tab.versions"), count: data.versions.length },
        ]}
      />

      <TabPanel idPrefix="question" value={tab} ref={panelRef}>
      {tab === "edit" ? (
        <QuestionEditTab
          data={data}
          pool={pool.data}
          draft={draft}
          setDraft={setDraft}
          issues={issues}
          edited={edited}
          readOnly={readOnly}
          onTry={onTry}
        />
      ) : tab === "try" ? (
        <TryPanel questionId={id} type={data.meta.type} />
      ) : (
        <VersionHistory questionId={id} versions={data.versions} />
      )}
      </TabPanel>

      {publishing ? (
        <PublishDialog
          questionId={id}
          draftIssues={issues}
          onClose={() => setPublishing(false)}
          onPublished={async (version) => {
            setPublishing(false);
            toast(t("question.published.toast", { n: version.number }), "success");
            await qc.invalidateQueries({ queryKey: questionKey(id) });
            await qc.invalidateQueries({ queryKey: poolKey(poolId) });
          }}
        />
      ) : null}
    </div>
  );
}
