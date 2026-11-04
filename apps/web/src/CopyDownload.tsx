import { Download, Loader2 } from "lucide-react";

import { useExportMenu } from "./download";
import { useT } from "./i18n";
import { IconButton, Menu } from "./ui";

/** `GET …/results/attempts/:attemptId/copy.<ext>` (ADR-125 §4, §5): the server names the file. */
const copyPath = (evaluationId: string, attemptId: string, ext: string): string =>
  `/app/api/evaluations/${evaluationId}/results/attempts/${attemptId}/copy.${ext}`;

/**
 * "Download the copy" of one student's attempt (ADR-125 §4, §5): a small menu,
 * the PDF (when the server makes PDFs, `config.pdf`) fetched so a refusal
 * is a toast, and the JSON record as a plain link. A secondary action of
 * the results per-student view and of the dashboard's inspect view; never
 * of the grading table, which is anonymised (F-GRADE-03).
 */
export function CopyDownload({ evaluationId, attemptId }: { evaluationId: string; attemptId: string }) {
  const t = useT();
  const { items, pending } = useExportMenu((ext) => copyPath(evaluationId, attemptId, ext), ["pdf", "json"]);
  return (
    <Menu
      label={t("results.copy.download")}
      items={items}
      trigger={
        // A PDF takes a moment: the trigger spins and waits until it has landed.
        <IconButton label={t("results.copy.download")} disabled={pending} aria-busy={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <Download />}
        </IconButton>
      }
    />
  );
}
