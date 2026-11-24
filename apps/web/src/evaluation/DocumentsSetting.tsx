import { FileCode2, FileText } from "lucide-react";
import { useState } from "react";

import { MAX_PROVIDED_DOCUMENTS, type ProvidedDocument } from "@quiz/contracts";

import { AppLink } from "../AppLink";
import { useCourseLibrary } from "../library/api";
import { useErrorToast } from "../notify";
import { useRoute } from "../router";
import { useT } from "../i18n";
import { Button, Checkbox, FormDialog, SettingRow, Skeleton } from "../ui";
import type { ConfigPatch } from "./editTarget";

/**
 * ADR-144 §7 (F-EVAL-37): the documents of the course's library an exam or
 * an exercise provides, beside the calculator and the notepad. The row names
 * the selection in its order; "Choose" opens the course's documents as
 * checkboxes, saved together (`documents`, replaced whole): the order is the
 * order they were ticked in, a box past the tenth is disabled, never refused
 * after the click. Frozen with the other settings (`configLock`), and never
 * shown on a poll, which the server refuses it on. An empty library says
 * where documents are added: the course's Documents tab.
 */
export function DocumentsSetting({
  courseId,
  selected,
  patch,
  disabled,
}: {
  /** The course whose library is offered: the evaluation's, or the template's. */
  courseId: string;
  /** The selection, in its order, as the server answered it. */
  selected: readonly ProvidedDocument[];
  patch: ConfigPatch;
  disabled: boolean;
}) {
  const t = useT();
  const [, navigate] = useRoute();
  const [choosing, setChoosing] = useState(false);
  const library = useCourseLibrary(courseId);
  const empty = library.data?.documents.length === 0 && selected.length === 0;

  return (
    <SettingRow
      title={t("eval.documents")}
      desc={
        empty ? (
          <>
            {t("eval.documents.empty")}{" "}
            <AppLink
              route={{ view: "course", id: courseId, tab: "documents" }}
              navigate={navigate}
              className="font-medium text-accent hover:underline"
            >
              {t("eval.documents.library")}
            </AppLink>
          </>
        ) : selected.length === 0 ? (
          t("eval.documents.none")
        ) : (
          selected.map((d) => d.title).join(" · ")
        )
      }
    >
      {empty ? null : (
        <Button size="sm" variant="secondary" disabled={disabled || library.isPending} onClick={() => setChoosing(true)}>
          {t("eval.documents.choose")}
        </Button>
      )}
      {choosing ? (
        <DocumentsDialog
          selected={selected}
          library={library.data?.documents ?? []}
          patch={patch}
          loading={library.isPending}
          onClose={() => setChoosing(false)}
        />
      ) : null}
    </SettingRow>
  );
}

/** The course's documents as checkboxes, ticked in order; Save sends the list. */
function DocumentsDialog({
  selected,
  library,
  loading,
  patch,
  onClose,
}: {
  selected: readonly ProvidedDocument[];
  library: readonly ProvidedDocument[];
  loading: boolean;
  patch: ConfigPatch;
  onClose: () => void;
}) {
  const t = useT();
  const toastError = useErrorToast();
  const [draft, setDraft] = useState<string[]>(() => selected.map((d) => d.id));
  const [saving, setSaving] = useState(false);
  const full = draft.length >= MAX_PROVIDED_DOCUMENTS;
  const tick = (id: string, on: boolean) => setDraft((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  const save = () => {
    setSaving(true);
    patch.mutate(
      { documents: draft },
      {
        onSuccess: onClose,
        onError: (error) => {
          setSaving(false);
          toastError("eval.saveFailed")(error);
        },
      },
    );
  };

  return (
    <FormDialog
      title={t("eval.documents")}
      submitLabel={t("common.save")}
      submitting={saving}
      onSubmit={save}
      onClose={onClose}
      dense
    >
      <p className="text-[13px] text-fg-muted">{t("eval.documents.dialog", { n: MAX_PROVIDED_DOCUMENTS })}</p>
      {loading ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <ul className="max-h-80 space-y-2 overflow-y-auto">
          {library.map((document) => {
            const rank = draft.indexOf(document.id);
            const Icon = document.kind === "pdf" ? FileText : FileCode2;
            return (
              <li key={document.id} className="flex items-center gap-2">
                <Checkbox
                  checked={rank >= 0}
                  disabled={full && rank < 0}
                  onChange={(e) => tick(document.id, e.target.checked)}
                  className="min-w-0 flex-1"
                  label={
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Icon className="size-4 shrink-0 text-fg-faint" aria-hidden />
                      <span className="min-w-0 [overflow-wrap:anywhere]">{document.title}</span>
                      <span className="sr-only">
                        {t(document.kind === "pdf" ? "courses.docs.kind.pdf" : "courses.docs.kind.markdown")}
                      </span>
                    </span>
                  }
                />
                {rank >= 0 ? (
                  <span className="shrink-0 text-xs tabular-nums text-fg-faint" aria-label={t("eval.documents.rank", { n: rank + 1 })}>
                    {rank + 1}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </FormDialog>
  );
}
