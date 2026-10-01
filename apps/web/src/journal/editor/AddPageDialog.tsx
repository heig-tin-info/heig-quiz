import { useState } from "react";

import { isJournalPagePath, safeJournalPath } from "@quiz/contracts";

import { useT } from "../../i18n";
import { Field, FormDialog, FormError } from "../../ui";
import { journalErrorText, useJournalAddPage } from "../api";

/**
 * Add a page (F-JRN-10): its file, a `.md` path inside the journal, and an
 * optional title, which the new file starts with as its heading. The file
 * name is proposed in the folder of the page being read, which is where a
 * week's next page goes. A path the route would refuse (`isJournalPagePath`,
 * `safeJournalPath`) keeps the button off and says why under the field.
 */
export function AddPageDialog({
  classroomId,
  folder,
  onClose,
  onAdded,
}: {
  classroomId: string;
  /** The folder proposed for the new file, with its trailing `/`, or "". */
  folder: string;
  onClose: () => void;
  onAdded: (path: string) => void;
}) {
  const t = useT();
  const add = useJournalAddPage(classroomId);
  const [path, setPath] = useState(folder);
  const [title, setTitle] = useState("");
  const trimmed = path.trim();
  const valid = isJournalPagePath(trimmed) && safeJournalPath(trimmed) !== null;
  const showInvalid = trimmed !== "" && trimmed !== folder && !valid;

  const submit = () => {
    // Enter in a field while the add is in flight sends nothing twice.
    if (!valid || add.isPending) return;
    const heading = title.trim();
    add.mutate(
      { path: trimmed, ...(heading ? { title: heading } : {}) },
      { onSuccess: (written) => onAdded(written.path) },
    );
  };

  return (
    <FormDialog
      title={t("journalPage.addTitle")}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={t("journalPage.addAction")}
      submitting={add.isPending}
      canSubmit={valid}
      error={<FormError error={add.error} describe={(error) => journalErrorText(error, t)} />}
    >
      <Field
        fullWidth
        autoFocus
        label={t("journalPage.path")}
        value={path}
        spellCheck={false}
        placeholder={t("journalPage.pathPlaceholder")}
        aria-invalid={showInvalid || undefined}
        onChange={(e) => setPath(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <p className={showInvalid ? "text-xs text-danger" : "text-xs text-fg-faint"}>
        {showInvalid ? t("journalPage.pathInvalid") : t("journalPage.pathHelp")}
      </p>
      <Field
        fullWidth
        label={t("journalPage.pageTitle")}
        hint={t("journalPage.pageTitleHint")}
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
      />
    </FormDialog>
  );
}
