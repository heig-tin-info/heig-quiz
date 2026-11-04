import { useMutation } from "@tanstack/react-query";
import { Braces, ChevronDown, Copy, Download, FileText } from "lucide-react";

import { usePublicConfig, wordedRefusal } from "../api";
import { downloadFile, fetchFile } from "../download";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { Button, Menu, type MenuItem } from "../ui";

/** The formats of the answers file (F-EXP-01, ADR-125). */
type Format = "md" | "pdf" | "json";

/** `GET …/items/:itemId/answers.<format>` (F-EXP-01): the server names the file. */
const answersPath = (evaluationId: string, itemId: string, format: Format): string =>
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
  // The server makes PDFs (ADR-125 §3); until it says so, no PDF is offered.
  const pdf = usePublicConfig().data?.pdf === true;
  const path = (format: Format) => answersPath(evaluationId, itemId, format);
  const copy = useMutation({
    mutationFn: () => copyFrom(path("md")),
    onSuccess: () => toast(t("grading.answers.copied"), "success"),
    onError: () => toast(t("grading.answers.copyFailed"), "error"),
  });
  // A PDF is built on request and may be refused (busy, no Typst): fetched, so the refusal is a toast.
  const printable = useMutation({
    mutationFn: () => downloadFile(path("pdf")),
    onError: (error) =>
      toast(wordedRefusal(error, { pdf_unavailable: "export.unavailable", pdf_busy: "export.busy", pdf_failed: "export.failed" }, t), "error"),
  });
  const items: MenuItem[] = [
    { label: t("md.label"), icon: FileText, href: path("md") },
    ...(pdf ? [{ label: t("export.pdf"), icon: Download, onSelect: () => printable.mutate() }] : []),
    { label: t("export.json"), icon: Braces, href: path("json") },
  ];
  return (
    // One group, so a narrow toolbar wraps the pair together.
    <span className="flex items-center gap-2">
      <Menu
        label={t("export.menu")}
        align="start"
        items={items}
        trigger={
          <Button variant="secondary" loading={printable.isPending} title={t("grading.answers.help")}>
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
