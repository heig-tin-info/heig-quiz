import { useMutation } from "@tanstack/react-query";
import { Braces, Download, FileText } from "lucide-react";

import { ApiError, usePublicConfig, wordedRefusal } from "./api";
import { useT, type Dict } from "./i18n";
import { useToast } from "./notify";
import type { MenuItem } from "./ui";

/** The file name of an attachment, as the server wrote it (`attachment; filename="…"`). */
function attachmentName(disposition: string | null, fallback: string): string {
  return /filename="([^"]+)"/.exec(disposition ?? "")?.[1] ?? fallback;
}

/**
 * A file the server builds on demand (an export, ADR-121), fetched rather
 * than followed as a link: a refusal (`503 pdf_busy`, `pdf_unavailable`)
 * throws an {@link ApiError} the screen words, and is never saved as the
 * file nor leaves the page. `name` is the server's own file name.
 */
export async function fetchFile(path: string): Promise<{ blob: Blob; name: string }> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return {
    blob: await res.blob(),
    name: attachmentName(res.headers.get("content-disposition"), path.split("/").pop() ?? "download"),
  };
}

/** Fetches a file ({@link fetchFile}) and hands it to the browser's downloads. */
async function downloadFile(path: string): Promise<void> {
  const { blob, name } = await fetchFile(path);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * A file downloaded as a mutation of the screen: `mutate(path)`, and a
 * refusal — a PDF the server cannot make now (ADR-125 §3), or any other — is
 * a toast, never a page left. `variables` is the path on its way.
 */
export function useDownload() {
  const t = useT();
  const toast = useToast();
  return useMutation({
    mutationFn: downloadFile,
    onError: (error) =>
      toast(
        wordedRefusal(
          error,
          {
            pdf_unavailable: "export.unavailable",
            pdf_busy: "export.busy",
            pdf_failed: "export.failed",
            // A student's documents: 20 an hour (ADR-112 amendment of 2026-11-03).
            rate_limited: "export.limited",
            // A type with no paper form, or a parameterized item (ADR-125 §5).
            not_printable: "export.notPrintable",
          },
          t,
        ),
        "error",
      ),
  });
}

/** The formats an export menu offers. */
export type ExportExt = "md" | "pdf" | "json";

const EXPORT_ITEM = {
  md: { label: "md.label", icon: FileText },
  pdf: { label: "export.pdf", icon: Download },
  json: { label: "export.json", icon: Braces },
} as const satisfies Record<ExportExt, { label: keyof Dict; icon: MenuItem["icon"] }>;

/**
 * The items of an export menu, in the order of `exts`: each format a plain
 * link, but the PDF, built on request and maybe refused, fetched through
 * {@link useDownload} — and left out while the server does not say it makes
 * PDFs (`config.pdf`, ADR-125 §3). `pending`: a PDF on its way.
 */
export function useExportMenu(
  path: (ext: ExportExt) => string,
  exts: readonly ExportExt[],
): { items: MenuItem[]; pending: boolean } {
  const t = useT();
  const pdf = usePublicConfig().data?.pdf === true;
  const download = useDownload();
  const items = exts
    .filter((ext) => ext !== "pdf" || pdf)
    .map((ext): MenuItem => {
      const { label, icon } = EXPORT_ITEM[ext];
      return ext === "pdf"
        ? { label: t(label), icon, onSelect: () => download.mutate(path(ext)) }
        : { label: t(label), icon, href: path(ext) };
    });
  return { items, pending: download.isPending };
}
