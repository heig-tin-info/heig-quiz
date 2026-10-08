import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { EvaluationDetail, TemplateDetail } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { tryAdapterFor } from "../questionTypes";
import { QUESTION_ORIGIN_PARAMS, routeToPath, useSearchParam, type Route } from "../router";
import { PageError, PageSkeleton, TabPanel, Tabs } from "../ui";
import { PublishDialog } from "./PublishDialog";
import { EditorExpandChrome } from "./EditorExpandLayer";
import { QuestionEditTab } from "./QuestionEditTab";
import { useEvaluationCrumbs, useRootCrumb, useTemplateCrumbs, type Crumb } from "../Trail";
import { QuestionHeader } from "./QuestionHeader";
import { TryPanel } from "./TryPanel";
import { useEditorShortcuts } from "./useEditorShortcuts";
import { useQuestionActions } from "./useQuestionActions";
import { useQuestionDraft } from "./useQuestionDraft";
import { VersionHistory } from "./VersionHistory";
import { evaluationKey, gradingKey, poolKey, questionKey, templateKey } from "../queryKeys";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The pages the editor may have been opened from, in the order they win,
 * each keyed by the query parameter that names it (`QUESTION_ORIGIN_PARAMS`):
 *
 * - `fromGrading` (+ `item`): the grading screen of an evaluation (ADR-044,
 *   addendum). Publishing leads back there at once — the fix was made to
 *   re-grade.
 * - `fromTemplate`: a template (F-EVAL-25).
 * - `from`: an evaluation (issue #127).
 *
 * The origin's page is the question's parent in the trail: the trail is that
 * page's own, then the question; without an origin it is the pool's.
 */
interface OriginSpec {
  param: Exclude<(typeof QUESTION_ORIGIN_PARAMS)[number], "item">;
  kind: "grading" | "template" | "evaluation";
  back: (id: string, item: string | null) => Route;
  /** Publishing is the way back (only from the grading screen). */
  returnOnPublish: boolean;
}

const ORIGINS: readonly OriginSpec[] = [
  {
    param: "fromGrading",
    kind: "grading",
    back: (id, item) => ({ view: "grading", evaluationId: id, ...(item ? { item } : {}) }),
    returnOnPublish: true,
  },
  { param: "fromTemplate", kind: "template", back: (id) => ({ view: "template", id }), returnOnPublish: false },
  { param: "from", kind: "evaluation", back: (id) => ({ view: "evaluation", id }), returnOnPublish: false },
];

interface Origin {
  kind: OriginSpec["kind"];
  /** The evaluation or template the page is about. */
  id: string;
  back: Route;
  /** The evaluation to refresh after a publication, or null: any origin but a template. */
  evaluationId: string | null;
  returnOnPublish: boolean;
}

/** The origin the query string names, or `null`: anything that is not an id is ignored. */
function useOrigin(): Origin | null {
  // One hook per param, spelled out: a hook in a loop is the rules of hooks
  // broken, however constant the list.
  const [from] = useSearchParam("from", "");
  const [fromTemplate] = useSearchParam("fromTemplate", "");
  const [fromGrading] = useSearchParam("fromGrading", "");
  const [item] = useSearchParam("item", "");
  const params: Record<(typeof QUESTION_ORIGIN_PARAMS)[number], string> = {
    from,
    fromTemplate,
    fromGrading,
    item,
  };
  const spec = ORIGINS.find((o) => UUID.test(params[o.param]));
  if (!spec) return null;
  const id = params[spec.param];
  return {
    kind: spec.kind,
    id,
    back: spec.back(id, UUID.test(params.item) ? params.item : null),
    evaluationId: spec.kind === "template" ? null : id,
    returnOnPublish: spec.returnOnPublish,
  };
}

/**
 * The question's ancestors: the origin page's own trail (the pages read the
 * evaluation or template from the cache the origin page filled; after a
 * reload, one request), else the pool's.
 */
function useQuestionCrumbs(origin: Origin | null, poolId: string | undefined, poolName: string | undefined): Crumb[] {
  const t = useT();
  const pools = useRootCrumb("pools");
  const evaluation = useQuery<EvaluationDetail>({
    queryKey: evaluationKey(origin?.evaluationId ?? ""),
    enabled: origin?.evaluationId != null,
    queryFn: () => api(`/app/api/evaluations/${origin!.evaluationId}`),
    retry: false,
  });
  const template = useQuery<TemplateDetail>({
    queryKey: templateKey(origin?.id ?? ""),
    enabled: origin?.kind === "template",
    queryFn: () => api(`/app/api/templates/${origin!.id}`),
    retry: false,
  });
  const evaluationCrumbs = useEvaluationCrumbs(
    evaluation.data?.evaluation.classroomId,
    origin?.id ?? "",
    evaluation.data?.evaluation.title,
  );
  const templateCrumbs = useTemplateCrumbs(
    template.data?.template.courseId,
    origin?.id ?? "",
    template.data?.template.title,
  );
  if (origin?.kind === "template") return templateCrumbs;
  if (origin?.kind === "evaluation") return evaluationCrumbs;
  if (origin?.kind === "grading") return [...evaluationCrumbs, { label: t("grading.title"), route: origin.back }];
  return [pools, ...(poolName === undefined || poolId === undefined ? [] : [{ label: poolName, route: { view: "pool", id: poolId } as Route }])];
}

/**
 * The question editor: what the question says, and beside it what it is.
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
  const { detail, pool, poolId, readOnly, draft, setDraft, autosave, issues, edited, savedStamp } =
    useQuestionDraft(id);
  const [publishing, setPublishing] = useState(false);
  const origin = useOrigin();
  const crumbs = useQuestionCrumbs(origin, poolId, pool.data?.pool.name);
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
  /*
   * The Try tab renders what the SERVER holds, like the student preview
   * above: the pending edit is sent at once rather than after the debounce.
   * The tab switches first, so a slow save never lands on a tab chosen
   * since; the save then refreshes the preview (`useQuestionDraft`).
   */
  const selectTab = useCallback(
    (next: Tab) => {
      setTab(next);
      if (next === "try") void flush();
    },
    [flush, setTab],
  );
  const openTry = useCallback(() => {
    followToPanel.current = true;
    selectTab("try");
  }, [selectTab]);
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
        crumbs={crumbs}
        readOnly={readOnly}
        autosave={autosave}
        navigate={navigate}
        onPublish={startPublish}
        onDuplicate={() => duplicate(data.meta)}
        onDelete={() => void askDelete(data.meta)}
      />

      <Tabs
        value={tab}
        onChange={selectTab}
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
        // The draft's save state, in the bar of a canvas's expand layer too.
        <EditorExpandChrome.Provider value={autosave.state}>
          <QuestionEditTab
            data={data}
            pool={pool.data}
            draft={draft}
            setDraft={setDraft}
            issues={issues}
            edited={edited}
            readOnly={readOnly}
            onTry={onTry}
            savedStamp={savedStamp}
            dirty={autosave.dirty}
            navigate={navigate}
          />
        </EditorExpandChrome.Provider>
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
            // The evaluation it came from now has a newer version to offer
            // (its stale badge, the grading screen's Re-grade).
            if (origin?.evaluationId) {
              void qc.invalidateQueries({ queryKey: evaluationKey(origin.evaluationId) });
              void qc.invalidateQueries({ queryKey: gradingKey(origin.evaluationId) });
            }
            // Opened from the grading screen, publishing IS the way back: the
            // fix was made to re-grade with it (ADR-044, addendum).
            if (origin?.returnOnPublish) navigate(origin.back);
          }}
        />
      ) : null}
    </div>
  );
}
