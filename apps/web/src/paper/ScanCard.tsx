/**
 * The scan of a paper copy (ADR-125 §15, F-PAPER-04): attached right after
 * the hand-in or later, replaced by a new upload, opened as a download.
 * Staff only, like everything under `paper/`. A secondary surface: the
 * screen it sits on has its own primary action.
 */
import { FileUp, Paperclip } from "lucide-react";
import { useRef } from "react";

import { PAPER_SCAN_MIMES } from "@quiz/domain";

import { formatBytes, useI18n, useT } from "../i18n";
import { useToast } from "../notify";
import { Button, Card, Skeleton, QueryError } from "../ui";
import { scanUrl, usePaperSheet, useUploadScan } from "./api";

/** What the picker offers; the server reads the bytes, never this list. */
const ACCEPT = PAPER_SCAN_MIMES.join(",");

export function ScanCard({ evaluationId, attemptId }: { evaluationId: string; attemptId: string }) {
  const t = useT();
  const { locale } = useI18n();
  const toast = useToast();
  const sheet = usePaperSheet(evaluationId, attemptId);
  const upload = useUploadScan(evaluationId, attemptId);
  const input = useRef<HTMLInputElement>(null);
  const scan = sheet.data?.scan ?? null;

  const pick = (file: File | undefined) => {
    if (!file) return;
    upload.mutate(file, {
      onSuccess: () => toast(t("paper.scan.attached"), "success"),
      onError: () => toast(t("paper.scan.failed"), "error"),
    });
  };

  return (
    <Card className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t("paper.scan.title")}</h2>
        {scan ? (
          <a
            className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted underline-offset-2 hover:underline"
            href={scanUrl(evaluationId, attemptId)}
            download
          >
            <Paperclip className="size-3.5" aria-hidden />
            {t("paper.scan.open")} · {formatBytes(scan.bytes, locale)}
          </a>
        ) : null}
      </div>
      {sheet.isPending ? (
        <Skeleton className="h-8 w-40" />
      ) : sheet.isError ? (
        <QueryError title={t("paper.scan.loadFailed")} query={sheet} />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <Button variant="secondary" loading={upload.isPending} onClick={() => input.current?.click()}>
            <FileUp /> {t(scan ? "paper.scan.replace" : "paper.scan.attach")}
          </Button>
          <p className="text-[13px] text-fg-muted">{t("paper.scan.help")}</p>
        </div>
      )}
    </Card>
  );
}
