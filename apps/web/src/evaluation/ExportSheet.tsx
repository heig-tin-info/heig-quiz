import { Ban, Download } from "lucide-react";

import type { PrintRefusal } from "@quiz/contracts";

import { usePublicConfig } from "../api";
import { useDownload } from "../download";
import { useT, type Dict } from "../i18n";
import { QueryError } from "../queryError";
import { typeLabel } from "../questionTypes";
import { Button, LinkButton, Sheet, Skeleton } from "../ui";
import { useEvaluation } from "./api";

/** The two documents of an evaluation (ADR-121 step 3, ADR-125), and their routes' stem. */
const DOCUMENTS = [
  { key: "handout", label: "eval.export.handout", desc: "eval.export.handout.desc" },
  { key: "document", label: "eval.export.document", desc: "eval.export.document.desc" },
] as const satisfies readonly { key: string; label: keyof Dict; desc: keyof Dict }[];

/** The formats each document downloads in as a plain link; the PDF comes first, fetched (ADR-125 §3). */
const FORMATS = [
  { ext: "md", label: "md.label" },
  { ext: "json", label: "export.json" },
] as const satisfies readonly { ext: string; label: keyof Dict }[];

/** The sentence of a refusal that names no type. */
const REFUSAL = {
  poll: "eval.export.poll",
  parameterized: "eval.export.parameterized",
} as const satisfies Record<Exclude<PrintRefusal["reason"], "type">, keyof Dict>;

/** `GET /evaluations/:id/<document>.<ext>`: the server names the file. */
const exportPath = (evaluationId: string, document: string, ext: string): string =>
  `/app/api/evaluations/${evaluationId}/${document}.${ext}`;

/**
 * "Export…" of an evaluation (ADR-121 step 3, ADR-125 §17): the hand-out to
 * print and the statement with its key, each a row of plain download links,
 * or a muted line saying why the evaluation does not make it (`exports` of
 * the detail, the server's `printRefusal`). The PDF first, when the server
 * makes PDFs (`config.pdf`): fetched, so a refusal (busy, no Typst) is a
 * toast and the sheet stays. A reading sheet: every button is a secondary
 * download, the screen behind keeps its primary. Opened from an evaluation
 * row's menu and from the evaluation page's.
 */
export function ExportSheet({
  evaluationId,
  title,
  onClose,
}: {
  evaluationId: string;
  title: string;
  onClose: () => void;
}) {
  const t = useT();
  const detail = useEvaluation(evaluationId);
  const pdf = usePublicConfig().data?.pdf === true;
  const download = useDownload();
  const refusalText = (refusal: PrintRefusal) =>
    refusal.reason === "type"
      ? t("eval.export.types", { types: refusal.types.map((type) => typeLabel(t, type)).join(", ") })
      : t(REFUSAL[refusal.reason]);

  return (
    <Sheet title={t("eval.export.title")} subtitle={title} onClose={onClose}>
      {detail.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-9 w-64" />
        </div>
      ) : detail.isError ? (
        <QueryError title={t("eval.export.loadFailed")} query={detail} />
      ) : (
        <div className="space-y-6">
          {DOCUMENTS.map(({ key, label, desc }) => {
            const refusal = detail.data.exports[key];
            return (
              <section key={key} aria-labelledby={`export-${key}`} className="space-y-2">
                <h3 id={`export-${key}`} className="text-base font-semibold">
                  {t(label)}
                </h3>
                <p className="text-sm text-fg-muted">{t(desc)}</p>
                {refusal ? (
                  <p className="flex items-center gap-2 text-sm text-fg-faint">
                    <Ban className="size-4 shrink-0" aria-hidden />
                    {refusalText(refusal)}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {pdf ? (
                      <Button
                        variant="secondary"
                        loading={download.isPending && download.variables === exportPath(evaluationId, key, "pdf")}
                        onClick={() => download.mutate(exportPath(evaluationId, key, "pdf"))}
                      >
                        <Download /> {t("export.pdf")}
                      </Button>
                    ) : null}
                    {FORMATS.map(({ ext, label: format }) => (
                      <LinkButton key={ext} href={exportPath(evaluationId, key, ext)} download>
                        <Download /> {t(format)}
                      </LinkButton>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </Sheet>
  );
}
