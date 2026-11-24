/**
 * The course library of the mock (F-ORG-18, ADR-144): PRG1 holds a few
 * documents — one of each kind, one a colleague added (no delete for an
 * assistant), one whose Markdown reported warnings and one whose file went
 * missing (a staging copy) — and every other course none; `?empty=1`
 * empties PRG1's too, `?many=1` fills its quota. The refusals follow the
 * API's (`library/service.ts`): the kind by the name here, the mock having
 * no bytes to read, and the quota.
 *
 * The preview reads a document: every PDF serves one small fictitious sample
 * (`samples/formulaire.pdf`, from its `.typ`), whole — the mock answers no
 * `Range`, and a file under 2 MiB is one request for pdf.js anyway — and
 * every Markdown document the HTML of `samples/aide-memoire.md`, rendered
 * by `@quiz/docrender` as the API renders an upload.
 */
import {
  DEFAULT_DOCUMENTS_QUOTA_BYTES,
  DEFAULT_DOCUMENT_MAX_BYTES,
  DOCUMENT_MARKDOWN_MAX_BYTES,
  DocumentsQuotaPatch,
  type CourseDocument,
  type CourseLibrary,
  type DocumentHtml,
  type ProvidedDocument,
} from "@quiz/contracts";
import { isEvaluationOver } from "@quiz/domain";

import { renderStandalone } from "@quiz/docrender";

import { dropMockDocument, mockDocumentUses } from "./evaluation";
import { courseOr404, ME_TEACHER, myRoleOn } from "./org";
import { D, flags, H, iso, MockError, on, refuse } from "./runtime";
import markdownSample from "./samples/aide-memoire.md?raw";
import pdfSample from "./samples/formulaire.pdf?url";


const me = { id: ME_TEACHER.userId, name: `${ME_TEACHER.givenName} ${ME_TEACHER.familyName}` };
const colleague = { id: "u2", name: "Pierre Roulet" };

const doc = (over: Partial<CourseDocument> & Pick<CourseDocument, "id" | "title" | "filename" | "kind" | "bytes">): CourseDocument => ({
  uploadedAt: iso(-2 * D),
  uploadedBy: me,
  warnings: [],
  missing: false,
  canDelete: true,
  usedBy: [],
  ...over,
});

const PRG1: CourseDocument[] = [
  doc({
    id: "5b0c8a1e-2f7d-4c3a-9e61-0d4b7a2c1f01",
    title: "Formulaire d'électronique",
    filename: "formulaire-electronique.pdf",
    kind: "pdf",
    bytes: 3_412_000,
    uploadedAt: iso(-3 * H),
  }),
  doc({
    id: "5b0c8a1e-2f7d-4c3a-9e61-0d4b7a2c1f02",
    title: "Aide-mémoire du langage C",
    filename: "aide-memoire.md",
    kind: "markdown",
    bytes: 18_420,
    uploadedAt: iso(-1 * D),
    warnings: [
      { code: "raw_html" },
      { code: "target_missing", href: "img/pointeurs.png", path: "img/pointeurs.png" },
    ],
  }),
  doc({
    id: "5b0c8a1e-2f7d-4c3a-9e61-0d4b7a2c1f03",
    title: "Fiche technique BRV2207",
    filename: "brv2207-datasheet.pdf",
    kind: "pdf",
    bytes: 31_250_000,
    uploadedAt: iso(-12 * D),
    uploadedBy: colleague,
    canDelete: false,
  }),
  doc({
    id: "5b0c8a1e-2f7d-4c3a-9e61-0d4b7a2c1f04",
    title: "Table ASCII",
    filename: "ascii.pdf",
    kind: "pdf",
    bytes: 96_000,
    uploadedAt: iso(-40 * D),
    missing: true,
  }),
];

interface MockLibrary {
  documents: CourseDocument[];
  quotaBytes: number;
}

const usedBytes = (library: Pick<MockLibrary, "documents">) => library.documents.reduce((sum, d) => sum + d.bytes, 0);

const libraries: Record<string, MockLibrary> = {
  c1: {
    documents: flags.empty ? [] : PRG1,
    // `?many=1`: the documents fill the quota exactly, the full state of the tab.
    quotaBytes: flags.many ? usedBytes({ documents: PRG1 }) : DEFAULT_DOCUMENTS_QUOTA_BYTES,
  },
};

const libraryOf = (courseId: string): MockLibrary =>
  (libraries[courseOr404(courseId).id] ??= { documents: [], quotaBytes: DEFAULT_DOCUMENTS_QUOTA_BYTES });

/** The rows as the reader may act on them: an owner deletes anything, an assistant what they added. */
const asRead = (courseId: string, d: CourseDocument): CourseDocument => ({
  ...d,
  canDelete: myRoleOn(courseId) === "owner" || d.uploadedBy.id === me.id,
  usedBy: mockDocumentUses(d.id),
});

/** ADR-144 §7: the course's documents of a selection, in its order; an id of no document of the course is left out. */
export function mockProvided(courseId: string, ids: readonly string[]): ProvidedDocument[] {
  const documents = libraries[courseId]?.documents ?? [];
  return ids.flatMap((id) => {
    const d = documents.find((x) => x.id === id);
    return d ? [{ id: d.id, title: d.title, kind: d.kind }] : [];
  });
}

const documentOr404 = (m: RegExpMatchArray) => {
  const library = libraryOf(m.groups!.id!);
  const found = library.documents.find((d) => d.id === m.groups!.documentId);
  if (!found) throw new MockError(404, "not_found");
  return { library, document: found };
};

on("GET", "/app/api/courses/:id/documents", (m): CourseLibrary => {
  const library = libraryOf(m.groups!.id!);
  return {
    documents: library.documents.map((d) => asRead(m.groups!.id!, d)),
    usedBytes: usedBytes(library),
    quotaBytes: library.quotaBytes,
  };
});

on("POST", "/app/api/courses/:id/documents", (m, body): CourseDocument => {
  const library = libraryOf(m.groups!.id!);
  const file = body.file instanceof File ? body.file : null;
  if (!file) throw refuse(400, "validation", "No file in the request");
  const pdf = /\.pdf$/i.test(file.name);
  const markdown = /\.(md|markdown)$/i.test(file.name);
  if (!pdf && !markdown) throw refuse(415, "document_unsupported", "a document is a PDF or a Markdown file");
  const cap = markdown ? DOCUMENT_MARKDOWN_MAX_BYTES : DEFAULT_DOCUMENT_MAX_BYTES;
  if (file.size > cap) throw refuse(413, "file_too_large", "the file is too large", { maxBytes: cap });
  const used = usedBytes(library);
  if (used + file.size > library.quotaBytes) {
    throw refuse(409, "quota_exceeded", "over quota", { usedBytes: used, quotaBytes: library.quotaBytes });
  }
  const created = doc({
    id: crypto.randomUUID(),
    // The server's title (`titleOf`): the name without its extension.
    title: file.name.replace(/\.[^.]+$/, "") || file.name,
    filename: file.name,
    kind: pdf ? "pdf" : "markdown",
    bytes: Math.max(1, file.size),
    uploadedAt: new Date().toISOString(),
  });
  library.documents.unshift(created);
  return created;
});

on("PATCH", "/app/api/courses/:id/documents/:documentId", (m, body): CourseDocument => {
  const { document } = documentOr404(m);
  document.title = String(body.title ?? document.title).trim() || document.title;
  return asRead(m.groups!.id!, document);
});

on("DELETE", "/app/api/courses/:id/documents/:documentId", (m) => {
  const { library, document } = documentOr404(m);
  if (!asRead(m.groups!.id!, document).canDelete) {
    throw refuse(403, "owner_required", "Only an owner of this course may do that");
  }
  // ADR-144 §7: a template or an evaluation not yet over holds it.
  const holding = mockDocumentUses(document.id).filter((use) => use.template || !isEvaluationOver(use.state));
  if (holding.length > 0) {
    throw refuse(409, "document_in_use", "an evaluation or a template still provides this document", { evaluations: holding });
  }
  library.documents.splice(library.documents.indexOf(document), 1);
  dropMockDocument(document.id);
  return undefined;
});

/** The file: the sample PDF, whole, for any PDF whose file is there; `404 file_missing` otherwise. */
on("GET", "/app/api/courses/:id/documents/:documentId/file", async (m) => {
  const { document } = documentOr404(m);
  if (document.missing) throw refuse(404, "file_missing", "the document's file is missing");
  if (document.kind !== "pdf") return new Response(markdownSample, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  const bytes = await (await fetch(pdfSample)).arrayBuffer();
  return new Response(bytes, {
    headers: { "content-type": "application/pdf", "content-length": String(bytes.byteLength) },
  });
});

/** A Markdown document's HTML: the sample, rendered as an upload is; a PDF has none. */
on("GET", "/app/api/courses/:id/documents/:documentId/html", (m): DocumentHtml => {
  const { document } = documentOr404(m);
  if (document.kind !== "markdown") throw new MockError(404, "not_found");
  const { html, toc } = renderStandalone(markdownSample);
  return { html, toc };
});

on("PATCH", "/app/api/admin/courses/:id/documents-quota", (m, body) => {
  const parsed = DocumentsQuotaPatch.safeParse(body);
  if (!parsed.success) throw refuse(400, "validation", "Invalid quota");
  libraryOf(m.groups!.id!).quotaBytes = parsed.data.quotaBytes;
  return parsed.data;
});
