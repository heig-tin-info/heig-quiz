/**
 * The staff's preview of a document of the course's library (ADR-144 §6):
 * the document viewer (`documents/DocumentViewer`) in the app's expand layer
 * (`ExpandPanel`), as a canvas of a question grows into it — the page
 * covered but for 16 px, the document's title on the left of the bar and
 * "Close", the layer's one action, on its right. Escape closes it once the
 * viewer has left the key alone (its search and its outline take the first
 * one).
 *
 * The viewer knows nothing of courses: this file hands it the URL of the
 * course's file route (a PDF, read by ranges) or the HTML the server
 * rendered at upload (a Markdown document). A document whose file is
 * missing has no preview (the row offers none). The rendering's warnings
 * stay in the list, under the row: the preview shows the document.
 */
import { useEffect, useRef } from "react";

import type { CourseDocument } from "@quiz/contracts";

import { DocumentViewer, type DocumentViewerHandle } from "../documents/DocumentViewer";
import { useT } from "../i18n";
import { ExpandPanel, QueryError, Spinner } from "../ui";
import { documentFileUrl, useDocumentHtml } from "./api";

export function DocumentPreview({
  courseId,
  document,
  onClose,
}: {
  courseId: string;
  document: CourseDocument;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <ExpandPanel open onClose={onClose} label={document.title} closeLabel={t("common.close")} title={document.title}>
      {document.kind === "pdf" ? (
        <Viewer source={{ kind: "pdf", url: documentFileUrl(courseId, document.id) }} title={document.title} />
      ) : (
        <MarkdownPreview courseId={courseId} document={document} />
      )}
    </ExpandPanel>
  );
}

/** A Markdown document: its HTML first, then the viewer. */
function MarkdownPreview({ courseId, document }: { courseId: string; document: CourseDocument }) {
  const t = useT();
  const html = useDocumentHtml(courseId, document.id);
  if (html.isPending) return <Spinner label={t("docs.loading")} className="h-full" />;
  if (html.isError) {
    return (
      <div className="grid h-full place-items-center px-4">
        <QueryError title={t("docs.failed")} query={html} />
      </div>
    );
  }
  return (
    <Viewer source={{ kind: "markdown", html: html.data.html, toc: html.data.toc }} title={html.data.title} />
  );
}

/** The viewer, the document focused on open: arrows and Page Up/Down read it at once. */
function Viewer(props: Pick<Parameters<typeof DocumentViewer>[0], "source" | "title">) {
  const handle = useRef<DocumentViewerHandle>(null);
  useEffect(() => handle.current?.focusDocument(), []);
  return <DocumentViewer ref={handle} {...props} />;
}
