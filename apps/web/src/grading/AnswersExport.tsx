import { useMutation } from "@tanstack/react-query";
import { ChevronDown, Copy, Download } from "lucide-react";

import { fetchFile, useExportMenu, type ExportExt } from "../download";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Button, Menu, type MenuItem } from "../ui";

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
 * The grading panel's one secondary action on a question whose type renders
 * as text (F-EXP-01, ADR-121): every student's answer in one file —
 * Markdown, PDF (when the server makes PDFs, ADR-125 §3) or the JSON record
 * — downloaded from a small menu, whose last item copies the Markdown to
 * the clipboard. Validate stays the screen's one primary action.
 */
export function AnswersExport({ evaluationId, itemId }: { evaluationId: string; itemId: string }) {
  const t = useT();
  const toast = useToast();
  const path = (format: ExportExt) => answersPath(evaluationId, itemId, format);
  // The write is started inside the item's click (Safari), the mutation only
  // waits for it: the button's spinner and the toasts.
  const copy = useMutation({
    mutationFn: (written: Promise<void>) => written,
    onSuccess: () => toast(t("grading.answers.copied"), "success"),
    onError: () => toast(t("grading.answers.copyFailed"), "error"),
  });
  // A PDF only when the server makes them, fetched so a refusal (busy, no Typst) is a toast.
  const exports = useExportMenu(path, ["md", "pdf", "json"]);
  const clipboard: MenuItem = {
    label: t("grading.answers.clipboard"),
    icon: Copy,
    separator: true,
    onSelect: () => {
      const written = copyFrom(path("md"));
      // Handled now, so a refusal before the mutation awaits it is never "unhandled".
      written.catch(() => {});
      copy.mutate(written);
    },
  };
  return (
    <Menu
      label={t("export.menu")}
      align="end"
      items={[...exports.items, clipboard]}
      trigger={
        <Button variant="secondary" loading={exports.pending || copy.isPending} title={t("grading.answers.help")}>
          <Download /> {t("export.menu")} <ChevronDown />
        </Button>
      }
    />
  );
}
