import { Download, Loader2 } from "lucide-react";

import { useExportMenu } from "./download";
import { useT } from "./i18n";
import { Button, IconButton, Menu } from "./ui";

/** `GET …/results/attempts/:attemptId/copy.<ext>` (ADR-125 §4, §5): the server names the file. */
const staffCopyPath = (evaluationId: string, attemptId: string) => (ext: string): string =>
  `/app/api/evaluations/${evaluationId}/results/attempts/${attemptId}/copy.${ext}`;

/** `GET /attempts/:id/copy.<ext>` (F-EXP-06): the student's own copy. */
const ownCopyPath = (attemptId: string) => (ext: string): string => `/app/api/attempts/${attemptId}/copy.${ext}`;

/**
 * Whose copy: one student's, for the staff (by evaluation and attempt), or
 * the caller's own (`own`, the feedback page). The staff call sites stay as
 * they were; the student's names its attempt only.
 */
type CopyOf = { evaluationId: string; attemptId: string; own?: undefined } | { own: string };

/**
 * "Download the copy" of one attempt (ADR-125 §4, §5; F-EXP-06): a small
 * menu, the PDF (when the server makes PDFs, `config.pdf`) fetched so a
 * refusal is a toast, and the JSON record as a plain link.
 *
 * - The staff's, a secondary action of the results per-student view and of
 *   the dashboard's inspect view (never of the grading table, which is
 *   anonymised, F-GRADE-03): an icon button.
 * - The student's own, under the score of their feedback page: `labelled`,
 *   a quiet ghost button that says what it does — the page has no primary.
 */
export function CopyDownload(props: CopyOf & { labelled?: boolean }) {
  const t = useT();
  const path = props.own !== undefined ? ownCopyPath(props.own) : staffCopyPath(props.evaluationId, props.attemptId);
  const label = t(props.own !== undefined ? "feedback.download" : "results.copy.download");
  const { items, pending } = useExportMenu(path, ["pdf", "json"]);
  return (
    <Menu
      label={label}
      align={props.labelled ? "start" : "end"}
      items={items}
      trigger={
        // A PDF takes a moment: the trigger spins and waits until it has landed.
        props.labelled ? (
          <Button variant="ghost" size="sm" loading={pending} aria-busy={pending}>
            {pending ? null : <Download />}
            {label}
          </Button>
        ) : (
          <IconButton label={label} disabled={pending} aria-busy={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Download />}
          </IconButton>
        )
      }
    />
  );
}
