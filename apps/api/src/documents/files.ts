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
export const EXPORT_FORMATS = ["md", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const CONTENT_TYPE: Record<ExportFormat, string> = {
  md: "text/markdown; charset=utf-8",
  json: "application/json; charset=utf-8",
};

/**
 * `found` as `<basename>.<format>`: the record parsed through its `schema`
 * (so the file is what the contract says), or the Markdown of the document
 * `tree` draws from it, built only when asked for.
 */
export function sendExport<R>(
  reply: FastifyReply,
  format: ExportFormat,
  found: { basename: string; record: R },
  schema: z.ZodType<R>,
  tree: () => Document,
): FastifyReply {
  const body = format === "json" ? JSON.stringify(schema.parse(found.record)) : renderMarkdown(tree());
  return sendAttachment(reply, CONTENT_TYPE[format], `${found.basename}.${format}`, body);
}
