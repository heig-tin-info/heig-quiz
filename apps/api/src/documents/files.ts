/**
 * The binding of the export factory (ADR-121) to HTTP: one export, served as
 * a file in one of its formats. Not a module: it owns no route and no table.
 * Each Source's module keeps its own routes, its loader (invariant 6) and
 * its record; this is the shared tail that turns the record into a download.
 */
import type { FastifyReply } from "fastify";
import type { z } from "zod";

import type { Document } from "@quiz/docexport";
import { renderMarkdown } from "@quiz/docexport/markdown";

import { sendAttachment } from "../modules/http.js";

/** The formats an export is served in. */
export const EXPORT_FORMATS = ["md", "json", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const CONTENT_TYPE: Record<ExportFormat, string> = {
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
  pdf: "application/pdf",
};

/**
 * `found` as `<basename>.<format>`: the record parsed through its `schema`
 * (so the file is what the contract says), or the document `tree` draws from
 * it, built only when asked for, as Markdown or as a PDF (ADR-125). The
 * document's provenance names the build here, once (ADR-121 §5). The PDF
 * draws the images the caller may see; `app.pdf` answers
 * `503 pdf_unavailable` or `pdf_busy` when it cannot make one. `delivered`
 * runs once the body exists, before it is sent: what counts a download (an
 * audit row, a rate) counts none that failed.
 */
export async function sendExport<R>(
  reply: FastifyReply,
  format: ExportFormat,
  found: { basename: string; record: R },
  schema: z.ZodType<R>,
  tree: () => Document,
  delivered?: () => Promise<void>,
): Promise<FastifyReply> {
  const { server, request } = reply;
  const document = (): Document => {
    const doc = tree();
    return { ...doc, provenance: { ...doc.provenance, app: server.commitSha } };
  };
  const body =
    format === "json"
      ? // Indented: a record is read by people too.
        JSON.stringify(schema.parse(found.record), null, 2)
      : format === "pdf"
        ? await server.pdf.render(document(), request.user!)
        : renderMarkdown(document());
  await delivered?.();
  return sendAttachment(reply, CONTENT_TYPE[format], `${found.basename}.${format}`, body);
}
