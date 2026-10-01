import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Copy, Eye, RotateCcw } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { JOURNAL_ASSET_MAX_BYTES, type JournalPageStaff, type JournalPreviewResult } from "@quiz/contracts";

import { useConfirm } from "../../confirm";
import { useT } from "../../i18n";
import { RichText } from "../../markdown/RichText";
import { useToast } from "../../notify";
import { useLeaveGuard } from "../../router";
import { Alert, Button, Field, QueryError } from "../../ui";
import { journalErrorText, journalRefusal, previewJournalPage, uploadJournalAsset, useJournalSave } from "../api";
import { JournalArticle } from "../JournalArticle";
import { composePage, readFields, splitPage, type PageFields } from "./frontMatter";
import { imagePlacement, journalImageUrl, randomSuffix } from "./images";
import { PageFieldsForm } from "./PageFieldsForm";
import { reconciler } from "./reconcile";

/*
 * The journal's editor (F-JRN-10, D25), in place of the page it edits, on the
 * reader's own route.
 *
 * The four decisions:
 * - Type: the text is edited in the page's own long-form type (`.md-doc`,
 *   the `h1` at 28 px), so what the teacher writes looks like what students
 *   read; the fields above it and the bar are 13 px UI.
 * - Color: ONE accent, Save, in the bar. Cancel is secondary; the conflict
 *   is the one red block, and its reload is `danger`, behind a confirmation.
 * - Space: the bar 24 above the sheet; inside the sheet the fields, a
 *   hairline, then the text, 16 apart; the change description under it.
 * - Finish: the same sheet as the page being read (surface, hairline, card
 *   radius), so opening the editor swaps the contents, not the frame.
 *
 * Markdown is the one truth: the page is split into its front matter (the
 * fields) and its body (the editor), and every keystroke composes them back
 * into the markdown that would be saved. What the rich surface emits is
 * reconciled with the body it opened on (reconcile.ts), so a block the
 * teacher did not edit is written as it was read. Save is enabled only when
 * that markdown differs from the page's, byte for byte (D25 condition 5).
 */

export interface JournalEditorProps {
  classroomId: string;
  page: JournalPageStaff;
  /** Back to reading: after a save, or when the teacher leaves. */
  onClose: () => void;
  /** The conflict's "reload": the page is read again, and the editor reopens on it. */
  onReload: () => void;
  /** Draws the bar and the body where the reader wants them. */
  children: (bar: ReactNode, body: ReactNode) => ReactNode;
}

export function JournalEditor({ classroomId, page: current, onClose, onReload, children }: JournalEditorProps) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();

  // The version the editor OPENED, for its whole life: a refetch of the page
  // underneath (a hint, a reconnect) changes neither the text being edited
  // nor the blob a save is checked against. A reload remounts the editor.
  const [page] = useState(current);
  const [opened] = useState(() => splitPage(page.markdown));
  const [fields, setFields] = useState<PageFields>(() => readFields(opened.yaml));
  const [body, setBody] = useState(opened.body);
  const [message, setMessage] = useState("");
  const [source, setSource] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reconcile] = useState(() => reconciler(opened.body));

  /** The markdown a save would send; a byte of difference is an edit. */
  const markdown = composePage(opened, fields, body);
  const dirty = markdown !== page.markdown;

  const save = useJournalSave(classroomId, page.path);

  const askLeave = useCallback(
    () =>
      confirm({
        title: t("journalEditor.leaveTitle"),
        message: t("journalEditor.leaveBody"),
        confirmLabel: t("journalEditor.leaveAction"),
        danger: true,
      }),
    [confirm, t],
  );
  useLeaveGuard(dirty, askLeave);

  // ------------------------------------------------------------- pictures
  /** The pictures uploaded in this session, drawn from the browser's copy until a save references them. */
  const local = useRef(new Map<string, string>());
  const imageUrl = useMemo(() => journalImageUrl(classroomId, page.path, local.current), [classroomId, page.path]);
  const uploadImage = useCallback(
    async (file: File): Promise<string> => {
      const placement = imagePlacement(page.path, file, randomSuffix());
      if (placement === null) {
        toast(t("journalEditor.imageType"), "error");
        throw new Error("unsupported image type");
      }
      if (file.size > JOURNAL_ASSET_MAX_BYTES) {
        toast(t("journalEditor.imageTooLarge"), "error");
        throw new Error("image too large");
      }
      try {
        await uploadJournalAsset(classroomId, placement.path, file);
      } catch (error) {
        toast(journalErrorText(error, t), "error");
        throw error;
      }
      local.current.set(placement.href, URL.createObjectURL(file));
      return placement.href;
    },
    [classroomId, page.path, t, toast],
  );

  // -------------------------------------------------------------- preview
  /** The source view's preview: the server's renderer, as students will read it (F-JRN-10). */
  const preview = useMutation<JournalPreviewResult, unknown, string>({
    mutationFn: (md) => previewJournalPage(classroomId, page.path, md),
  });

  // ----------------------------------------------------------------- save
  const submit = () => {
    if (!dirty || conflict) return;
    const description = message.trim();
    save.mutate(
      { markdown, baseSha: page.blobSha, ...(description ? { message: description } : {}) },
      {
        onSuccess: (written) => {
          toast(written.page ? t("journalEditor.saved") : t("journalEditor.savedPending"), "success");
          onClose();
        },
        onError: (error) => {
          if (journalRefusal(error) === "conflict") setConflict(true);
          else toast(journalErrorText(error, t), "error");
        },
      },
    );
  };

  const cancel = async () => {
    if (dirty && !(await askLeave())) return;
    onClose();
  };

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      toast(t("journalEditor.copied"), "success");
    } catch {
      toast(t("journalEditor.copyFailed"), "error");
    }
  };

  const reload = async () => {
    const ok = await confirm({
      title: t("journalEditor.reloadTitle"),
      message: t("journalEditor.reloadBody"),
      confirmLabel: t("journalEditor.reloadAction"),
      danger: true,
    });
    if (ok) onReload();
  };

  const bar = (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
      <span role="status" className="mr-auto text-xs text-fg-faint">
        {dirty ? t("journalEditor.unsaved") : t("journalEditor.unchanged")}
      </span>
      <Button variant="secondary" size="sm" onClick={() => void cancel()} disabled={save.isPending}>
        {t("common.cancel")}
      </Button>
      <Button size="sm" onClick={submit} disabled={!dirty || conflict} loading={save.isPending}>
        {t("journalEditor.save")}
      </Button>
    </div>
  );

  const content = (
    <div className="space-y-4">
      {conflict ? (
        <Alert tone="danger" icon={AlertTriangle} title={t("journalEditor.conflictTitle")}>
          <p>{t("journalEditor.conflictBody")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => void copyDraft()}>
              <Copy /> {t("journalEditor.copyDraft")}
            </Button>
            <Button variant="danger" size="sm" onClick={() => void reload()}>
              <RotateCcw /> {t("journalEditor.reload")}
            </Button>
          </div>
        </Alert>
      ) : null}

      <div className="space-y-4 rounded-card border border-line bg-surface px-5 py-6 sm:px-8 sm:py-7">
        <PageFieldsForm fields={fields} onChange={setFields} />
        <div className="border-t border-line" />
        <RichText
          value={body}
          onChange={setBody}
          aria-label={t("journalEditor.body")}
          placeholder={t("journalEditor.bodyPlaceholder")}
          rows={16}
          journal
          imageUrl={imageUrl}
          reconcile={reconcile}
          uploadImage={uploadImage}
          onSourceChange={(on) => {
            setSource(on);
            preview.reset();
          }}
          className="journal-editor"
        />
        {source ? (
          <SourcePreview
            classroomId={classroomId}
            pagePath={page.path}
            result={preview.data}
            error={preview.error}
            pending={preview.isPending}
            onPreview={() => preview.mutate(markdown)}
          />
        ) : null}
      </div>

      <Field
        fullWidth
        label={t("journalEditor.message")}
        hint={t("journalEditor.messageHint")}
        value={message}
        maxLength={200}
        placeholder={t("journalEditor.messagePlaceholder", { path: page.path })}
        onChange={(e) => setMessage(e.target.value)}
      />
    </div>
  );

  return <>{children(bar, content)}</>;
}

/**
 * Under the source view, the page as the server renders it (the students'
 * renderer, `POST …/preview`), on demand: the rich view is its own preview,
 * the source view is not.
 */
function SourcePreview({
  classroomId,
  pagePath,
  result,
  error,
  pending,
  onPreview,
}: {
  classroomId: string;
  pagePath: string;
  result: JournalPreviewResult | undefined;
  error: unknown;
  pending: boolean;
  onPreview: () => void;
}) {
  const t = useT();
  return (
    <section aria-label={t("journalEditor.preview")} className="space-y-3 border-t border-line pt-4">
      <div className="flex items-center gap-3">
        <p className="mr-auto text-xs text-fg-faint">{t("journalEditor.previewHint")}</p>
        <Button variant="secondary" size="sm" loading={pending} onClick={onPreview}>
          {pending ? null : <Eye />} {t("journalEditor.preview")}
        </Button>
      </div>
      {error ? <QueryError title={t("journalEditor.previewFailed")} error={error} onRetry={onPreview} /> : null}
      {result ? (
        <div className="rounded-field bg-surface-2 px-4 py-3">
          <JournalArticle
            html={result.html}
            classroomId={classroomId}
            pagePath={pagePath}
            onOpen={() => {}}
            keepScroll
          />
        </div>
      ) : null}
    </section>
  );
}
