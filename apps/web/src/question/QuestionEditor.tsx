import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, Eye, Save, Trash2, CloudUpload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  Asset,
  DraftSaved,
  PoolDetail,
  PreviewResult,
  QuestionDetail,
  ZodIssueLite,
} from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { MarkdownField } from "../markdown/MarkdownField";
import { useToast } from "../notify";
import { QuestionEditorHost, QuestionPlayerHost, typeIcon, typeLabel } from "../questionTypes";
import type { Route } from "../router";
import { useSearchParam } from "../router";
import { useScreenCommands } from "../screenCommands";
import {
  Alert,
  Badge,
  Button,
  Card,
  Menu,
  PageHeader,
  QueryError,
  SectionHeading,
  Skeleton,
  Spinner,
  SyncBadge,
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
 * student preview) or in the overflow menu (duplicate, delete, save now).
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
  const [publishing, setPublishing] = useState(false);
  const [preview, setPreview] = useState(false);

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

  // The draft that arrives from the server replaces the local copy: it is
  // also how "restore v2 into the draft" lands on screen.
  const serverDraft = detail.data?.draft;
  const serverStamp = serverDraft?.updatedAt;
  useEffect(() => {
    if (serverDraft) setDraft({ config: serverDraft.config, explanation: serverDraft.explanation });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stamp is the identity of a draft
  }, [serverStamp]);

  const save = useCallback(
    async (value: Draft) => {
      const saved = await api<DraftSaved>(`/app/api/questions/${id}/draft`, {
        method: "PUT",
        body: JSON.stringify({ config: value.config, explanation: value.explanation }),
      });
      setIssues(saved.issues);
      return saved;
    },
    [id],
  );

  const autosave = useAutosave<Draft>({
    value: draft ?? { config: null, explanation: "" },
    save,
    enabled: draft !== null,
  });

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

  // docs/spec/08 §8.4: Ctrl+S saves (the automatic save is invisible and a
  // teacher wants to be sure), Ctrl+Shift+P publishes, Ctrl+Shift+M shows the
  // student preview. All three are reachable with the mouse as well.
  const { flush } = autosave;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "s" && !e.shiftKey) {
        e.preventDefault();
        flush();
        return;
      }
      if (!e.shiftKey) return;
      if (key === "p") {
        e.preventDefault();
        setPublishing(true);
      } else if (key === "m") {
        e.preventDefault();
        setPreview((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush]);

  // The editor's own palette entries (docs/spec/08 §8.3). They carry the
  // shortcut as a hidden keyword, so typing "ctrl+shift+p" finds the action
  // it belongs to.
  useScreenCommands([
    {
      id: "question:publish",
      label: t("palette.publish"),
      icon: CloudUpload,
      group: "action",
      keywords: "ctrl+shift+p",
      run: () => setPublishing(true),
    },
    {
      id: "question:preview",
      label: t("palette.preview"),
      icon: Eye,
      group: "action",
      keywords: "ctrl+shift+m",
      run: () => setPreview((v) => !v),
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
      <QueryError
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
  const invalid = issues.length > 0 || data.draft.valid === false;

  return (
    <div className="space-y-6">
      <PageHeader
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
            <SyncBadge state={autosave.state} />
          </span>
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setPreview((v) => !v)} aria-pressed={preview}>
              <Eye /> {t("question.preview")}
            </Button>
            <Button onClick={() => setPublishing(true)}>{t("question.publish")}</Button>
            <Menu
              label={t("common.actions")}
              items={[
                { label: t("question.saveNow"), icon: Save, onSelect: () => autosave.flush() },
                { label: t("question.duplicate"), icon: Copy, onSelect: () => duplicate.mutate() },
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
                  onChange={(config) => setDraft({ ...draft, config })}
                  issues={configIssues}
                  uploadAsset={uploadAsset}
                />
              ) : (
                <Spinner />
              )}
            </Card>

            <Card className="space-y-3 p-5">
              <p className="text-sm text-fg-muted">{t("question.explanationHint")}</p>
              <MarkdownField
                label={t("question.explanation")}
                value={draft?.explanation ?? ""}
                onChange={(explanation) =>
                  setDraft((current) => (current ? { ...current, explanation } : current))
                }
                onUploadImage={async (file) => ({ id: (await uploadAsset(file)).slice("asset:".length) })}
              />
            </Card>

            <p className="text-xs text-fg-faint">{t("question.shortcuts")}</p>
          </div>

          <aside className="space-y-5">
            <MetaPanel
              meta={data.meta}
              categories={pool.data?.categories ?? []}
              poolName={pool.data?.pool.name ?? "—"}
            />
            {preview ? <StudentPreview questionId={id} type={data.meta.type} /> : null}
          </aside>
        </div>
      ) : tab === "try" ? (
        <TryPanel questionId={id} type={data.meta.type} />
      ) : (
        <VersionHistory questionId={id} versions={data.versions} />
      )}

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

/** The draft as a student would receive it, beside the form (Ctrl+Shift+M). */
function StudentPreview({ questionId, type }: { questionId: string; type: string }) {
  const t = useT();
  const preview = useQuery<PreviewResult>({
    queryKey: ["question", questionId, "preview", "draft"],
    queryFn: () =>
      api(`/app/api/questions/${questionId}/preview`, {
        method: "POST",
        body: JSON.stringify({ source: "draft" }),
      }),
  });
  return (
    <Card className="space-y-3 p-4">
      <SectionHeading title={t("question.preview")} />
      {preview.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : preview.isError ? (
        <Alert tone="warning" icon={AlertTriangle} title={t("question.previewFailed")}>
          {apiErrorMessage(preview.error, t("error.server"))}
        </Alert>
      ) : (
        <QuestionPlayerHost
          t={t}
          type={type}
          student={preview.data?.student}
          answer={null}
          onChange={() => {}}
          readOnly
        />
      )}
    </Card>
  );
}
