/**
 * The Documents tab of a course (F-ORG-18, ADR-144): the PDF and Markdown
 * files its staff provide, which an evaluation will hand to its students
 * where nothing but Quiz may be opened (Safe Exam Browser, a kiosk station).
 *
 * The tab's one primary action, "Add a document", sits in the page header
 * (`CoursePage`): it opens a file picker, and the files picked are sent one
 * after the other by {@link useDocumentUploads}, which lives in the page so
 * that a change of tab does not drop an upload in flight. Under it: what is
 * being sent, what was refused and why, the space the course uses (an
 * administrator sets the quota inline), and the documents — each with its
 * kind, size, who added it and when, what its Markdown rendering reported,
 * and its download, rename and delete. A delete is offered to the uploader
 * and to an owner of the course, as the server allows. No preview yet.
 */
import { AlertTriangle, Download, FileCode2, FileText, Pencil, Trash2, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import {
  DOCUMENT_ACCEPT,
  DOCUMENT_TITLE_MAX,
  DOCUMENTS_QUOTA_LIMIT_BYTES,
  type CourseDocument,
  type CourseLibrary,
} from "@quiz/contracts";
import { useQueryClient } from "@tanstack/react-query";

import { useMe } from "../api";
import { useConfirm } from "../confirm";
import { formatBytes, useI18n, useT } from "../i18n";
import type { WarningWords } from "../journal/words";
import { warningText } from "../journal/words";
import { useErrorToast, useToast } from "../notify";
import { courseLibraryKey } from "../queryKeys";
import {
  Actions,
  Alert,
  Badge,
  Card,
  cx,
  EmptyState,
  IconButton,
  Progress,
  QueryError,
  RelativeTime,
  Skeleton,
  TextFieldDialog,
  TextInput,
} from "../ui";
import {
  documentFileUrl,
  uploadDocument,
  uploadRefusalOf,
  useCourseLibrary,
  useDeleteDocument,
  useRenameDocument,
  useSetDocumentsQuota,
  type UploadRefusal,
} from "./api";

/** The quota is typed in MB, the unit `formatBytes` shows it in. */
const MB = 1_000_000;

/** One file the server refused, with why. */
interface Refused {
  name: string;
  refusal: UploadRefusal;
}

/** The uploads of the Documents tab: the picker, what is being sent, what was refused. */
export interface DocumentUploads {
  /** Opens the file picker: the header's primary action. */
  pick: () => void;
  /** The hidden file input, rendered once by the page. */
  picker: ReactNode;
  /** The file being sent, its rank and the count of the batch; null when idle. */
  progress: { n: number; total: number; name: string } | null;
  refused: Refused[];
  dismiss: () => void;
}

/**
 * The picker and the sending of its files, one after the other: a refused
 * file does not stop the next. The library is read again once the batch is
 * through; a toast counts what was added, the tab lists what was refused.
 */
export function useDocumentUploads(courseId: string): DocumentUploads {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<DocumentUploads["progress"]>(null);
  const [refused, setRefused] = useState<Refused[]>([]);

  const send = async (files: File[]) => {
    setRefused([]);
    const failed: Refused[] = [];
    let added = 0;
    for (const [i, file] of files.entries()) {
      setProgress({ n: i + 1, total: files.length, name: file.name });
      try {
        await uploadDocument(courseId, file);
        added += 1;
      } catch (error) {
        failed.push({ name: file.name, refusal: uploadRefusalOf(error) });
      }
    }
    setProgress(null);
    setRefused(failed);
    await qc.invalidateQueries({ queryKey: courseLibraryKey(courseId) });
    if (added > 0) toast(added === 1 ? t("courses.docs.added.one") : t("courses.docs.added.many", { n: added }), "success");
  };

  return {
    pick: () => input.current?.click(),
    picker: (
      <input
        ref={input}
        type="file"
        multiple
        accept={DOCUMENT_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="document-picker"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length > 0) void send(files);
        }}
      />
    ),
    progress,
    refused,
    dismiss: () => setRefused([]),
  };
}

export function CourseDocuments({ courseId, uploads }: { courseId: string; uploads: DocumentUploads }) {
  const t = useT();
  const library = useCourseLibrary(courseId);

  return (
    <div className="space-y-4">
      {uploads.progress ? (
        <Progress
          label={t("courses.docs.uploading", {
            n: uploads.progress.n,
            total: uploads.progress.total,
            name: uploads.progress.name,
          })}
        />
      ) : null}
      {uploads.refused.length > 0 ? <RefusedFiles refused={uploads.refused} onDismiss={uploads.dismiss} /> : null}
      {library.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : library.isError ? (
        <QueryError title={t("courses.docs.loadFailed")} query={library} />
      ) : (
        <>
          <QuotaMeter courseId={courseId} library={library.data} />
          {library.data.documents.length === 0 ? (
            // Words, not a second button: "Add a document" is in the header.
            <Card>
              <EmptyState icon={FileText} title={t("courses.docs.empty.title")}>
                {t("courses.docs.empty.body")}
              </EmptyState>
            </Card>
          ) : (
            <Card className="divide-y divide-line px-4">
              {library.data.documents.map((document) => (
                <DocumentRow key={document.id} courseId={courseId} document={document} />
              ))}
            </Card>
          )}
        </>
      )}
      <p className="text-[13px] text-fg-muted">{t("courses.docs.licence")}</p>
    </div>
  );
}

/** The files of the last batch the server refused, each with its reason. */
function RefusedFiles({ refused, onDismiss }: { refused: Refused[]; onDismiss: () => void }) {
  const t = useT();
  const { locale } = useI18n();
  const reason = ({ name, refusal }: Refused): string => {
    switch (refusal.code) {
      case "document_unsupported":
        return t("courses.docs.refused.unsupported", { name });
      case "file_too_large":
        return t("courses.docs.refused.tooLarge", { name, max: formatBytes(refusal.maxBytes, locale) });
      case "quota_exceeded":
        return t("courses.docs.refused.quota", { name, free: formatBytes(refusal.freeBytes, locale) });
      case "failed":
        return t("courses.docs.refused.failed", { name });
    }
  };
  return (
    <Alert
      tone="danger"
      icon={AlertTriangle}
      title={t("courses.docs.refused.title")}
      action={
        <IconButton size="sm" label={t("common.close")} onClick={onDismiss}>
          <X />
        </IconButton>
      }
    >
      <ul className="space-y-0.5">
        {refused.map((file, i) => (
          <li key={i} className="break-words">
            {reason(file)}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

/**
 * The space the course's documents use, over its quota ("62 MB of 100 MB"),
 * as a thin bar: amber from 90 %, red once full, with the one line saying
 * what to do then. An administrator types the quota in place, in MB.
 */
function QuotaMeter({ courseId, library }: { courseId: string; library: CourseLibrary }) {
  const t = useT();
  const { locale } = useI18n();
  const admin = useMe().data?.role === "admin";
  const { usedBytes, quotaBytes } = library;
  const share = quotaBytes === 0 ? 1 : Math.min(1, usedBytes / quotaBytes);
  const full = usedBytes >= quotaBytes;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px]">
        <span className="text-fg-muted">{t("courses.docs.quota.label")}</span>
        <span className="flex items-center gap-2 tabular-nums">
          {admin ? (
            <>
              <span>{t("courses.docs.quota.used", { used: formatBytes(usedBytes, locale) })}</span>
              <QuotaField courseId={courseId} quotaBytes={quotaBytes} />
            </>
          ) : (
            t("courses.docs.quota", { used: formatBytes(usedBytes, locale), quota: formatBytes(quotaBytes, locale) })
          )}
        </span>
      </div>
      <div
        role="meter"
        aria-label={t("courses.docs.quota.label")}
        aria-valuemin={0}
        aria-valuemax={quotaBytes}
        aria-valuenow={Math.min(usedBytes, quotaBytes)}
        aria-valuetext={t("courses.docs.quota", { used: formatBytes(usedBytes, locale), quota: formatBytes(quotaBytes, locale) })}
        className="h-1.5 overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className={cx("h-full rounded-full", full ? "bg-danger" : share >= 0.9 ? "bg-warning" : "bg-fg-faint")}
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
      {full ? <p className="text-[13px] text-danger">{t("courses.docs.quota.full")}</p> : null}
    </div>
  );
}

/** The quota as an administrator types it, in MB: written when the field is left, anything out of bounds put back. */
function QuotaField({ courseId, quotaBytes }: { courseId: string; quotaBytes: number }) {
  const t = useT();
  const toastError = useErrorToast();
  const saved = String(Math.round(quotaBytes / MB));
  const [value, setValue] = useState(saved);
  const save = useSetDocumentsQuota(courseId);
  const commit = () => {
    const mb = value.trim() === "" ? NaN : Number(value);
    if (!Number.isInteger(mb) || mb < 0 || mb * MB > DOCUMENTS_QUOTA_LIMIT_BYTES) {
      setValue(saved);
      return;
    }
    if (mb * MB !== quotaBytes) save.mutate(mb * MB, { onError: (e) => { setValue(saved); toastError("error.save")(e); } });
  };
  return (
    <label className="flex items-center gap-1.5">
      <TextInput
        type="number"
        min={0}
        max={DOCUMENTS_QUOTA_LIMIT_BYTES / MB}
        inputMode="numeric"
        aria-label={t("courses.docs.quota.field")}
        size="sm"
        className="w-20 text-right tabular-nums"
        value={value}
        disabled={save.isPending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span className="text-fg-muted">{t("courses.docs.quota.unit")}</span>
    </label>
  );
}

/**
 * A rendering's warnings in the journal's words, but the images': a
 * document carries no image and no linked file (ADR-144 §3).
 */
const DOCUMENT_WARNINGS: WarningWords = {
  external_image: (w, t) => t("courses.docs.warning.image", { href: w.href }),
  target_missing: (w, t) => t("courses.docs.warning.target", { href: w.href }),
  asset_too_large: (w, t) => t("courses.docs.warning.target", { href: w.href }),
};

function DocumentRow({ courseId, document }: { courseId: string; document: CourseDocument }) {
  const t = useT();
  const { locale } = useI18n();
  const confirm = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const [renaming, setRenaming] = useState(false);
  const rename = useRenameDocument(courseId);
  const remove = useDeleteDocument(courseId);
  const Icon = document.kind === "pdf" ? FileText : FileCode2;

  const confirmDelete = async () => {
    const ok = await confirm({
      title: t("courses.docs.deleteTitle"),
      message: t("courses.docs.deleteConfirm", { title: document.title }),
      confirmLabel: t("courses.docs.delete"),
      danger: true,
    });
    if (ok) {
      remove.mutate(document.id, {
        onSuccess: () => toast(t("courses.docs.deleted"), "success"),
        onError: toastError("error.save"),
      });
    }
  };

  return (
    <div className="flex items-start gap-3 py-3">
      <Icon className="mt-0.5 size-5 shrink-0 text-fg-faint" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate font-medium">{document.title}</span>
          {document.missing ? (
            <Badge tone="amber" icon={AlertTriangle}>
              {t("courses.docs.missing")}
            </Badge>
          ) : null}
        </div>
        <p className="text-[13px] text-fg-muted">
          {t(document.kind === "pdf" ? "courses.docs.kind.pdf" : "courses.docs.kind.markdown")} ·{" "}
          <span className="tabular-nums">{formatBytes(document.bytes, locale)}</span> ·{" "}
          {document.uploadedBy.name} · <RelativeTime iso={document.uploadedAt} />
        </p>
        <p className="truncate text-xs text-fg-faint">{document.filename}</p>
        {document.missing ? <p className="text-[13px] text-fg-muted">{t("courses.docs.missing.hint")}</p> : null}
        {document.warnings.length > 0 ? (
          <ul className="space-y-0.5 text-[13px] text-fg-muted">
            {document.warnings.map((warning, i) => (
              <li key={i} className="flex items-start gap-1.5 break-words">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                {warningText(warning, t, DOCUMENT_WARNINGS)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <Actions
        label={t("common.actions")}
        size="sm"
        items={[
          ...(document.missing
            ? []
            : [{ label: t("courses.docs.download"), icon: Download, href: documentFileUrl(courseId, document.id) }]),
          { label: t("courses.docs.rename"), icon: Pencil, onSelect: () => setRenaming(true) },
          ...(document.canDelete
            ? [{ label: t("courses.docs.delete"), icon: Trash2, danger: true, onSelect: () => void confirmDelete() }]
            : []),
        ]}
      />
      {renaming ? (
        <TextFieldDialog
          title={t("courses.docs.renameTitle")}
          label={t("courses.docs.titleField")}
          initial={document.title}
          submitLabel={t("courses.docs.rename")}
          valid={(value) => value.trim().length > 0 && value.trim().length <= DOCUMENT_TITLE_MAX}
          submitting={rename.isPending}
          onSubmit={(title) =>
            rename.mutate(
              { id: document.id, title },
              { onSuccess: () => setRenaming(false), onError: toastError("error.save") },
            )
          }
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </div>
  );
}
