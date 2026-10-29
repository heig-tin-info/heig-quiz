import { useMutation } from "@tanstack/react-query";
import { Copy, Download } from "lucide-react";

import { useT } from "../i18n";
import { useToast } from "../notify";
import { Button, LinkButton } from "../ui";

/** `GET …/items/:itemId/answers.md` (F-EXP-01): the server names the file. */
export const answersPath = (evaluationId: string, itemId: string): string =>
  `/app/api/evaluations/${evaluationId}/items/${itemId}/answers.md`;

async function markdownOf(path: string): Promise<Blob> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`answers export: ${res.status}`);
  return new Blob([await res.text()], { type: "text/plain" });
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
 * renders as text (F-EXP-01, ADR-121): every student's answer in one
 * Markdown file, downloaded (a plain link, as the results CSV) or copied.
 * Validate stays the screen's one primary action.
 */
export function AnswersExport({ evaluationId, itemId }: { evaluationId: string; itemId: string }) {
  const t = useT();
  const toast = useToast();
  const path = answersPath(evaluationId, itemId);
  const copy = useMutation({
    mutationFn: () => copyFrom(path),
    onSuccess: () => toast(t("grading.answers.copied"), "success"),
    onError: () => toast(t("grading.answers.copyFailed"), "error"),
  });
  return (
    <>
      <LinkButton href={path} download title={t("grading.answers.help")}>
        <Download /> {t("grading.answers.export")}
      </LinkButton>
      <Button variant="secondary" loading={copy.isPending} onClick={() => copy.mutate()} title={t("grading.answers.help")}>
        <Copy /> {t("grading.answers.copy")}
      </Button>
    </>
  );
}
