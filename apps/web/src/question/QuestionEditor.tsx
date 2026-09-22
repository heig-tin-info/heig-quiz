import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, Eye, Play, Save, Trash2, CloudUpload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  Asset,
  DraftSaved,
  PoolDetail,
  QuestionDetail,
  TryResult,
  ZodIssueLite,
} from "@quiz/contracts";
import type { CircuitConfig, CircuitDetails } from "@quiz/qt-circuit/client";
import { referenceRegions, type CodeConfig, type CodeDetails } from "@quiz/qt-code/client";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { HelpIcon } from "../help";
import { useT } from "../i18n";
import { MarkdownField } from "../markdown/MarkdownField";
import { useToast } from "../notify";
import { QuestionEditorHost, typeIcon, typeLabel, type TryOutcome } from "../questionTypes";
import { routeToPath, useSearchParam, type Route } from "../router";
import { BrowserRunnerUnavailable, runnerFor } from "../runner";
import { referenceRunRequest } from "../runner/codeRun";
import { useScreenCommands } from "../screenCommands";
import { useShortcuts } from "../shortcuts";
import {
  Alert,
  Badge,
  Button,
  Card,
  LinkButton,
  Menu,
  modKey,
  PageError,
  PageHeader,
  Skeleton,
  Spinner,
  SyncBadge,
  TabPanel,
  Tabs,
} from "../ui";
import { useAutosave } from "./autosave";
import { toConfigIssues } from "./issues";
import { MetaPanel } from "./MetaPanel";
import { PublishDialog } from "./PublishDialog";
import { TryPanel } from "./TryPanel";
import { VersionHistory } from "./VersionHistory";

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

interface Draft {
  config: unknown;
  explanation: string;
}

export function QuestionEditor({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [rawTab, setTab] = useSearchParam("tab", "edit");
  const tab: Tab = rawTab === "try" || rawTab === "versions" ? rawTab : "edit";
  const [draft, setDraft] = useState<Draft | null>(null);
  const [issues, setIssues] = useState<readonly ZodIssueLite[]>([]);
  // Whether the teacher has changed anything in this session. A question is
  // created EMPTY now (the type's `emptyDraft()` carries no content), so its
  // stored draft is invalid from the first second and the warning below would
  // greet every new question with a complaint about work not yet started.
  const [edited, setEdited] = useState(false);
  const [publishing, setPublishing] = useState(false);
  /**
   * The slot of the right column a question type may portal its settings
   * into (`EditorProps.aside`): the mcq editor puts its "Scoring" card there,
   * under "Properties". STATE and not a ref, because the element does not
   * exist on the first render and a ref would never tell the editor it does.
   */
  const [scoringSlot, setScoringSlot] = useState<HTMLDivElement | null>(null);
  // The tab panel, so `Ctrl+Enter` can put the reader inside what it opened.
  const panelRef = useRef<HTMLDivElement>(null);
  const followToPanel = useRef(false);

  const detail = useQuery<QuestionDetail>({
    queryKey: ["question", id],
    queryFn: () => api(`/app/api/questions/${id}`),
  });
  const meta = detail.data?.meta;
  const poolId = meta?.poolId;
  const pool = useQuery<PoolDetail>({
    queryKey: ["pool", poolId],
    queryFn: () => api(`/app/api/pools/${poolId!}`),
    enabled: poolId !== undefined,
  });
  /*
   * A pool shared with me as `reader` (`PoolDetail.role`, the same predicate
   * `PoolView` uses for its own list). The question is READABLE — that is the
   * point of sharing — so the screen stays whole: the form, the properties
   * and the Try tab are all there, simply not writable. Nothing is hidden
   * except the actions that would be refused.
   *
   * The query is the one the pool screen already filled, so this costs no
   * request; while it is in flight the screen is writable-looking for a
   * moment, and the server refuses anyway (`staffAccess` / the pool role) —
   * this is chrome, never the rule.
   */
  const readOnly = pool.data?.role === "reader";

  // `DraftSaved.updatedAt` of the last write THIS editor made. It is what
  // tells our own draft apart from a foreign one when the question query
  // comes back (see the effect below).
  const ownStamp = useRef<string | null>(null);

  const save = useCallback(
    async (value: Draft) => {
      const saved = await api<DraftSaved>(`/app/api/questions/${id}/draft`, {
        method: "PUT",
        body: JSON.stringify({ config: value.config, explanation: value.explanation }),
      });
      ownStamp.current = saved.updatedAt;
      setIssues(saved.issues);
      return saved;
    },
    [id],
  );

  // `enabled: false` for a reader: not one `PUT /draft` leaves the browser,
  // whatever a control that slipped through would do to the local draft.
  const autosave = useAutosave<Draft>({
    value: draft ?? { config: null, explanation: "" },
    save,
    enabled: draft !== null && !readOnly,
  });

  /**
   * The draft that arrives from the server replaces the local copy — that is
   * how "restore v2 into the draft" and an edit made in another tab land on
   * screen. Two guards keep it from eating what the teacher is writing:
   *
   * - **our own echo is ignored.** `PUT /draft` makes the API emit a pool
   *   hint, `live.ts` invalidates every query, this one refetches and comes
   *   back carrying a NEW `updatedAt`. Replacing the local draft with it
   *   would hand `useAutosave` a new reference, which saves again, which
   *   hints again: an endless round trip. So anything not strictly newer
   *   than the stamp OUR last save returned is our own writing coming home.
   * - **a dirty draft is never overwritten.** While something is typed or on
   *   the wire, the local copy is the ahead one, whatever the server says.
   */
  const serverDraft = detail.data?.draft;
  const serverStamp = serverDraft?.updatedAt;
  const { dirty } = autosave;
  useEffect(() => {
    if (!serverDraft || !serverStamp) return;
    if (dirty) return;
    if (ownStamp.current !== null && new Date(serverStamp) <= new Date(ownStamp.current)) return;
    setDraft({ config: serverDraft.config, explanation: serverDraft.explanation });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stamp is the identity of a draft
  }, [serverStamp]);

  const uploadAsset = useCallback(
    async (file: File): Promise<string> => {
      const form = new FormData();
      form.append("file", file);
      const asset = await api<Asset>(`/app/api/pools/${poolId!}/assets`, {
        method: "POST",
        body: form,
      });
      return `asset:${asset.id}`;
    },
    [poolId],
  );

  const duplicate = useMutation({
    mutationFn: () =>
      api<QuestionDetail>(`/app/api/questions/${id}/copy`, {
        method: "POST",
        body: JSON.stringify({ targetPoolId: poolId }),
      }),
    onSuccess: async (copy) => {
      toast(t("question.duplicated"), "success");
      await qc.invalidateQueries({ queryKey: ["pool", poolId] });
      navigate({ view: "question", id: copy.meta.id });
    },
    onError: (error) => toast(apiErrorMessage(error, t("error.save")), "error"),
  });

  const remove = useMutation({
    mutationFn: () => api(`/app/api/questions/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["pool", poolId] });
      if (poolId) navigate({ view: "pool", id: poolId });
      else navigate({ view: "pools" });
    },
    onError: (error) => toast(apiErrorMessage(error, t("question.deleteFailed")), "error"),
  });

  const askDelete = useCallback(async () => {
    if (!meta) return;
    const ok = await confirm({
      title: t("question.delete"),
      message: t("question.deleteConfirm", { name: meta.internalName }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      danger: true,
    });
    if (ok) remove.mutate();
  }, [confirm, meta, remove, t]);

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

  /**
   * "Try the reference solution" (`CodeEditor`), on whichever runner the
   * question asks for — the same choice a STUDENT'S "Run" goes through
   * (`src/runner/`, ADR-015), so a teacher rehearses on the engine their
   * class will meet.
   *
   * The reference solution is read as one piece per editable region
   * (`referenceRegions`, `@@next` between them). The editor refuses a
   * mismatch before it ever calls this, which is why `null` below is a bug
   * and not a state: it throws rather than inventing a verdict.
   *
   *  - `runtime: "runno"`: the browser runner runs the program assembled
   *    here from the DRAFT's template and those regions, with the teacher's
   *    compiler flags and the real content of the extra files — the editor
   *    holds the whole config, so nothing has to be withheld the way
   *    `toStudent` withholds it from a student. It answers a raw
   *    `RunnerOutcome` and the editor judges the cases itself.
   *  - `runtime: "backend"`, or a browser runtime that would not load:
   *    `POST /questions/:id/try` grades the reference solution as an ANSWER.
   *    It returns a grading, not a run (`TryResult` carries no per-case
   *    runner outcome), so what comes back is the server's own verdict —
   *    `{ graded }` — and the editor shows it instead of re-deciding it.
   */
  const tryReference = useCallback(
    async (raw: unknown): Promise<TryOutcome> => {
      const config = raw as CodeConfig;
      const regions = referenceRegions(config);
      if (regions === null) throw new Error("reference solution does not fit the template");

      const browser = await runnerFor(config.runtime, config.language);
      if (browser !== null) {
        try {
          return await browser.run(referenceRunRequest(config, regions));
        } catch (error) {
          // The runtime did not load on this deployment: the server answers
          // the same question, exactly as it does for a student.
          if (!(error instanceof BrowserRunnerUnavailable)) throw error;
        }
      }

      // The route grades what the server HOLDS, so the draft goes first.
      flush();
      const result = await api<TryResult>(`/app/api/questions/${id}/try`, {
        method: "POST",
        body: JSON.stringify({ source: "draft", answer: { regions } }),
      });
      if (result.status !== "graded") return "unavailable";
      const details = result.details as CodeDetails;
      if (details.runner !== "ok") return "unavailable";
      return {
        graded: {
          // `null` is a language with no compile step, not a failure.
          compileOk: details.compile?.ok ?? true,
          passed: details.cases.filter((c) => c.ok).length,
          total: details.cases.length,
        },
      };
    },
    [flush, id],
  );

  /**
   * "Simulate the reference" (`CircuitEditor`).
   *
   * There is no browser half and there never will be: a SPICE netlist is
   * assembled SERVER-SIDE from the stored schematic and the stimulus
   * (invariant 14), so the teacher's own circuit is posted as an ANSWER to
   * `POST /questions/:id/try` and what comes back is this type's own
   * breakdown — the waveforms already decimated and already paired with the
   * stimulus that produced them.
   *
   * `runner_unavailable` is the default deployment (decision D14), not a
   * failure: the editor says so in one line and publication is unaffected.
   */
  const trySimulateReference = useCallback(
    async (raw: unknown): Promise<TryOutcome> => {
      const config = raw as CircuitConfig;
      // The route grades what the server HOLDS, so the draft goes first.
      flush();
      const result = await api<TryResult>(`/app/api/questions/${id}/try`, {
        method: "POST",
        body: JSON.stringify({ source: "draft", answer: { schematic: config.reference } }),
      });
      if (result.status !== "graded") return "unavailable";
      return { details: result.details as CircuitDetails };
    },
    [flush, id],
  );

  // docs/spec/08 §8.4: Ctrl+S saves (the automatic save is invisible and a
  // teacher wants to be sure), Ctrl+Shift+P publishes, Ctrl+Shift+M opens the
  // student preview in a new tab, Ctrl+Enter tries the question. All four are
  // reachable with the mouse as well.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "s" && !e.shiftKey) {
        e.preventDefault();
        if (!readOnly) flush();
        return;
      }
      // §8.5 "Essayer la question": the draft is saved first — the Try tab
      // runs what the SERVER holds, and trying a question without the edit
      // that prompted the try is the one thing this shortcut must not do.
      // The focus follows into the panel; a shortcut that moves the screen
      // and leaves the caret behind has moved only half the reader.
      if (key === "enter" && !e.shiftKey) {
        e.preventDefault();
        flush();
        followToPanel.current = true;
        setTab("try");
        return;
      }
      if (!e.shiftKey) return;
      if (key === "p") {
        e.preventDefault();
        if (!readOnly) setPublishing(true);
      } else if (key === "m") {
        e.preventDefault();
        openPreview();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush, openPreview, readOnly, setTab]);

  // The same four, shown in the sidebar strip while this screen is mounted.
  // The sentence that used to spell them out under the form is gone: a hint
  // that only the editor carried is now the frame's, and it follows the page.
  useShortcuts(
    readOnly
      ? [
          { keys: `${modKey()}+Enter`, label: t("question.tab.try") },
          { keys: `${modKey()}+Shift+M`, label: t("question.preview") },
        ]
      : [
          { keys: `${modKey()}+S`, label: t("common.save") },
          { keys: `${modKey()}+Enter`, label: t("question.tab.try") },
          { keys: `${modKey()}+Shift+P`, label: t("question.publish") },
          { keys: `${modKey()}+Shift+M`, label: t("question.preview") },
        ],
  );

  useEffect(() => {
    if (!followToPanel.current) return;
    followToPanel.current = false;
    panelRef.current?.focus();
  }, [tab]);

  // The editor's own palette entries (docs/spec/08 §8.3). They carry the
  // shortcut as a hidden keyword, so typing "ctrl+shift+p" finds the action
  // it belongs to.
  useScreenCommands([
    ...(readOnly
      ? []
      : [
          {
            id: "question:publish",
            label: t("palette.publish"),
            icon: CloudUpload,
            group: "action" as const,
            keywords: "ctrl+shift+p",
            run: () => setPublishing(true),
          },
        ]),
    {
      id: "question:preview",
      label: t("palette.preview"),
      icon: Eye,
      group: "action",
      keywords: "ctrl+shift+m",
      run: openPreview,
    },
    {
      id: "question:try",
      label: t("question.tab.try"),
      icon: Play,
      group: "action",
      keywords: "ctrl+enter",
      run: () => {
        followToPanel.current = true;
        setTab("try");
      },
    },
  ]);

  const configIssues = useMemo(() => toConfigIssues(t, issues), [t, issues]);

  if (detail.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
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
  const latest = data.latestPublished;
  // "Unpublished changes" is about the STORED draft, not about the request in
  // flight: a draft saved yesterday and never published is still ahead.
  const draftAhead =
    latest !== null &&
    (autosave.dirty || new Date(data.draft.updatedAt) > new Date(latest.publishedAt));
  const Icon = typeIcon(data.meta.type);
  // Reported, not predicted: the alert appears once a save came back with
  // issues, or once the teacher has touched a draft the server already holds
  // as invalid. The Publish dialog reports the issues unconditionally — that
  // is the moment the draft has to be complete.
  const invalid = issues.length > 0 || (edited && data.draft.valid === false);

  return (
    <div className="space-y-6">
      <PageHeader
        help="question-editor"
        eyebrow={
          <button
            type="button"
            className="text-fg-muted transition-colors hover:text-fg"
            onClick={() => navigate({ view: "pool", id: data.meta.poolId })}
          >
            {pool.data?.pool.name ?? t("pools.title")}
          </button>
        }
        title={<span className="font-mono">{data.meta.internalName}</span>}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="zinc" icon={Icon}>
              {typeLabel(t, data.meta.type)}
            </Badge>
            {latest ? (
              <Badge tone="green">{t("question.published", { n: latest.number })}</Badge>
            ) : (
              <Badge tone="amber">{t("question.draft")}</Badge>
            )}
            {draftAhead ? (
              <Badge tone="amber">{t("question.unpublished")}</Badge>
            ) : null}
            {readOnly ? (
              <Badge tone="zinc" icon={Eye}>
                {t("question.readOnly")}
              </Badge>
            ) : (
              <SyncBadge state={autosave.state} />
            )}
          </span>
        }
        actions={
          <>
            {/* It opens a TAB, so it is an anchor: middle-click, Ctrl-click
                and "open in a new window" all have to work, and a <button>
                offers none of them. `noopener` on both halves. */}
            <LinkButton
              variant="secondary"
              href={routeToPath({ view: "questionPreview", id })}
              target="_blank"
              rel="noopener"
              onClick={() => flush()}
            >
              <Eye /> {t("question.preview")}
            </LinkButton>
            {/*
             * A reader keeps the preview and loses the rest. Publish, save and
             * delete would each be refused by the server, and "duplicate"
             * writes into THIS pool, which a reader may not do either — so the
             * overflow menu has nothing left to hold and goes with them, rather
             * than staying as a row of actions that answer with an error.
             */}
            {readOnly ? null : (
              <>
                <Button onClick={() => setPublishing(true)}>{t("question.publish")}</Button>
                <Menu
                  label={t("common.actions")}
                  items={[
                    { label: t("question.saveNow"), icon: Save, onSelect: () => autosave.flush() },
                    {
                      label: t("question.duplicate"),
                      icon: Copy,
                      onSelect: () => duplicate.mutate(),
                    },
                    {
                      label: t("question.delete"),
                      icon: Trash2,
                      danger: true,
                      separator: true,
                      onSelect: () => void askDelete(),
                    },
                  ]}
                />
              </>
            )}
          </>
        }
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
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0 space-y-5">
            {invalid ? (
              <Alert tone="warning" icon={AlertTriangle} title={t("question.invalidDraft")}>
                {t("question.invalidDraftBody")}
              </Alert>
            ) : null}

            <Card className="p-5">
              {draft ? (
                <QuestionEditorHost
                  t={t}
                  type={data.meta.type}
                  config={draft.config}
                  onChange={(config) => {
                    setEdited(true);
                    setDraft({ ...draft, config });
                  }}
                  issues={configIssues}
                  disabled={readOnly}
                  uploadAsset={uploadAsset}
                  aside={scoringSlot}
                  {...(data.meta.type === "code" ? { onTry: tryReference } : {})}
                  {...(data.meta.type === "circuit" ? { onTry: trySimulateReference } : {})}
                />
              ) : (
                <Spinner />
              )}
            </Card>

            <Card className="space-y-3 p-5">
              {/*
               * The label is rendered HERE, and `MarkdownField`'s own is
               * hidden: the "?" is a SIBLING of the label, never inside it
               * (DESIGN.md, "Field"), and `MarkdownField` has no slot beside
               * its label. The prop is still passed, because that is what
               * names the editing surface — a contenteditable takes its name
               * from `aria-label`, not from a `<label for>`.
               */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] font-medium text-fg">{t("question.explanation")}</span>
                <HelpIcon topic="explanation" />
              </div>
              <MarkdownField
                className="[&>label]:hidden"
                disabled={readOnly}
                label={t("question.explanation")}
                value={draft?.explanation ?? ""}
                onChange={(explanation) => {
                  setEdited(true);
                  setDraft((current) => (current ? { ...current, explanation } : current));
                }}
                onUploadImage={async (file) => ({ id: (await uploadAsset(file)).slice("asset:".length) })}
              />
            </Card>
          </div>

          <aside aria-label={t("aside.questionMeta")} className="space-y-5">
            <MetaPanel
              meta={data.meta}
              categories={pool.data?.categories ?? []}
              poolName={pool.data?.pool.name ?? "—"}
              disabled={readOnly}
            />
            {/* Where the type's own settings land, under "Properties". Empty
                for a type that portals nothing, and then it must not eat a
                row of the column's spacing. */}
            <div ref={setScoringSlot} className="empty:hidden" />
          </aside>
        </div>
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
            await qc.invalidateQueries({ queryKey: ["question", id] });
            await qc.invalidateQueries({ queryKey: ["pool", poolId] });
          }}
        />
      ) : null}
    </div>
  );
}
