import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Copy, Download } from "lucide-react";

import { fetchFile, useExportMenu, type ExportExt } from "../download";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Button, Menu } from "../ui";

/** `GET …/items/:itemId/answers.<format>` (F-EXP-01): the server names the file. */
const answersPath = (evaluationId: string, itemId: string, format: ExportExt): string =>
  `/app/api/evaluations/${evaluationId}/items/${itemId}/answers.${format}`;

/** The Markdown file as plain text, the one type every clipboard takes. */
async function markdownOf(path: string): Promise<Blob> {
  const { blob } = await fetchFile(path);
  return new Blob([await blob.text()], { type: "text/plain" });
}

/**
 * Hands the clipboard a PROMISE of the text, inside the click: Safari refuses
 * a clipboard write made after the request's `await`. A browser without
 * `ClipboardItem` gets the text once it has arrived.
 */
async function copyFrom(path: string): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": markdownOf(path) })]);
  } else {
    await navigator.clipboard.writeText(await (await markdownOf(path)).text());
  }
}

/**
 * The grading panel's two secondary actions on a question whose type
 * renders as text (F-EXP-01, ADR-121): every student's answer in one file —
 * Markdown, PDF (when the server makes PDFs, ADR-125 §3) or the JSON record
 * — downloaded from a small menu, or copied as Markdown. Validate stays the
 * screen's one primary action.
 */
export function AnswersExport({ evaluationId, itemId }: { evaluationId: string; itemId: string }) {
  const t = useT();
  const toast = useToast();
  const path = (format: ExportExt) => answersPath(evaluationId, itemId, format);
  const copy = useMutation({
    mutationFn: () => copyFrom(path("md")),
    onSuccess: () => toast(t("grading.answers.copied"), "success"),
    onError: () => toast(t("grading.answers.copyFailed"), "error"),
  });
  // A PDF only when the server makes them, fetched so a refusal (busy, no Typst) is a toast.
  const exports = useExportMenu(path, ["md", "pdf", "json"]);
  return (
    // One group, so a narrow toolbar wraps the pair together.
    <span className="flex items-center gap-2">
      <Menu
        label={t("export.menu")}
        align="start"
        items={exports.items}
        trigger={
          <Button variant="secondary" loading={exports.pending} title={t("grading.answers.help")}>
            <Download /> {t("export.menu")} <ChevronDown />
          </Button>
        }
      />
      <Button variant="secondary" loading={copy.isPending} onClick={() => copy.mutate()} title={t("grading.answers.help")}>
        <Copy /> {t("grading.answers.copy")}
      </Button>
    </span>
  );
}
