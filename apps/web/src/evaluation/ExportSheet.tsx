import { Ban, Download } from "lucide-react";
import { useState } from "react";

import type { EvaluationDetail, PrintRefusal } from "@quiz/contracts";
import { variantLetter } from "@quiz/domain";

import { usePublicConfig } from "../api";
import { useDownload } from "../download";
import { useT, type Dict } from "../i18n";
import { QueryError } from "../queryError";
import { typeLabel } from "../questionTypes";
import { Button, LinkButton, Select, Sheet, Skeleton } from "../ui";
import { useEvaluation } from "./api";
import { PaperVariants } from "./PaperVariants";

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
} as const satisfies Record<Exclude<PrintRefusal["reason"], "type">, keyof Dict>;

/**
 * `GET /evaluations/:id/<document>.<ext>?variant=`: the server names the file.
 * `variant` is a number, or `all` for one PDF of every variant (ADR-148);
 * none where the paper has one.
 */
const exportPath = (evaluationId: string, document: string, ext: string, variant: number | "all" | null): string =>
  `/app/api/evaluations/${evaluationId}/${document}.${ext}${variant === null ? "" : `?variant=${variant}`}`;

/**
 * "Export…" of an evaluation (ADR-121 step 3, ADR-125 §17): the hand-out to
 * print and the statement with its key, each a row of plain download links,
 * or a muted line saying why the evaluation does not make it (`exports` of
 * the detail, the server's `printRefusal`). The PDF first, when the server
 * makes PDFs (`config.pdf`): fetched, so a refusal (busy, no Typst) is a
 * toast and the sheet stays. A reading sheet: every button is a secondary
 * download, the screen behind keeps its primary. Opened from an evaluation
 * row's menu and from the evaluation page's.
 *
 * Above them, where two papers can differ, the paper's variants (ADR-148):
 * their count and Redraw. With several, one choice names what the downloads
 * are of — every variant in one PDF by default, or one variant, which also
 * downloads as Markdown and JSON.
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
        <ExportDocuments evaluationId={evaluationId} exports={detail.data.exports} />
      )}
    </Sheet>
  );
}

function ExportDocuments({ evaluationId, exports }: { evaluationId: string; exports: EvaluationDetail["exports"] }) {
  const t = useT();
  const pdf = usePublicConfig().data?.pdf === true;
  const { variants } = exports;
  const several = variants.count > 1;
  const [chosen, setChosen] = useState<number | "all">("all");
  // One variant: none named. Beyond the count after a change: every variant again.
  const variant = !several ? null : chosen !== "all" && chosen > variants.count ? "all" : chosen;
  const download = useDownload(variant === "all" ? { pdf_failed: "eval.export.allFailed" } : {});
  const refusalText = (refusal: PrintRefusal) =>
    refusal.reason === "type"
      ? t("eval.export.types", { types: refusal.types.map((type) => typeLabel(t, type)).join(", ") })
      : t(REFUSAL[refusal.reason]);

  return (
    <div className="space-y-6">
      {exports.handout === null && (variants.varies || several) ? (
        <PaperVariants evaluationId={evaluationId} variants={variants} />
      ) : null}
      {several ? (
        <Select
          label={t("eval.export.variant")}
          width="w-52"
          value={String(variant)}
          onChange={(e) => setChosen(e.target.value === "all" ? "all" : Number(e.target.value))}
        >
          <option value="all">{t("eval.export.variant.all")}</option>
          {Array.from({ length: variants.count }, (_, i) => (
            <option key={i} value={i + 1}>
              {t("eval.export.variant.one", { letter: variantLetter(i + 1) })}
            </option>
          ))}
        </Select>
      ) : null}
      {DOCUMENTS.map(({ key, label, desc }) => {
        const refusal = exports[key];
        const pdfPath = exportPath(evaluationId, key, "pdf", variant);
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
                    loading={download.isPending && download.variables === pdfPath}
                    onClick={() => download.mutate(pdfPath)}
                  >
                    <Download /> {t("export.pdf")}
                  </Button>
                ) : null}
                {/* Markdown and JSON hold one variant: none for every variant at once. */}
                {variant === "all"
                  ? null
                  : FORMATS.map(({ ext, label: format }) => (
                      <LinkButton key={ext} href={exportPath(evaluationId, key, ext, variant)} download>
                        <Download /> {t(format)}
                      </LinkButton>
                    ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
