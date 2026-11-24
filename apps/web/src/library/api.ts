/**
 * The course library's reads and writes (F-ORG-18, F-ADMIN-10, ADR-144):
 * its documents, an upload, a rename, a delete, the file, and the course's
 * quota. Staff only.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  CourseDocumentPatch,
  DOCUMENT_UPLOAD_REFUSALS,
  DocumentsQuotaPatch,
  FileTooLarge,
  QuotaExceeded,
  type CourseDocument,
  type CourseLibrary,
} from "@quiz/contracts";

import { api, ApiError, refusalCodeOf } from "../api";
import { courseLibraryKey } from "../queryKeys";

const base = (courseId: string) => `/app/api/courses/${courseId}/documents`;

/** The document's file: a download, never shown inline. */
export const documentFileUrl = (courseId: string, documentId: string) => `${base(courseId)}/${documentId}/file`;

/** `GET /courses/:id/documents`: the library, newest first, its use and its quota. */
export function useCourseLibrary(courseId: string) {
  return useQuery<CourseLibrary>({
    queryKey: courseLibraryKey(courseId),
    queryFn: () => api(base(courseId)),
  });
}

/** `POST /courses/:id/documents`: one file, multipart. */
export function uploadDocument(courseId: string, file: File): Promise<CourseDocument> {
  const form = new FormData();
  form.append("file", file);
  return api<CourseDocument>(base(courseId), { method: "POST", body: form });
}

/** Why an upload was refused, in the terms the screen words it: the contract's refusals, or a failure. */
export type UploadRefusal =
  | { code: "document_unsupported" }
  | ({ code: "file_too_large" } & FileTooLarge)
  | { code: "quota_exceeded"; freeBytes: number }
  | { code: "failed" };

/** The refusal of an upload, read with the contract's schemas; anything else is a failure. */
export function uploadRefusalOf(error: unknown): UploadRefusal {
  const code = DOCUMENT_UPLOAD_REFUSALS.find((refusal) => refusal === refusalCodeOf(error));
  const body = error instanceof ApiError ? error.body : null;
  if (code === "document_unsupported") return { code };
  if (code === "file_too_large") {
    const tooLarge = FileTooLarge.safeParse(body);
    if (tooLarge.success) return { code, ...tooLarge.data };
  }
  if (code === "quota_exceeded") {
    const quota = QuotaExceeded.safeParse(body);
    if (quota.success) return { code, freeBytes: Math.max(0, quota.data.quotaBytes - quota.data.usedBytes) };
  }
  return { code: "failed" };
}

/** `PATCH /courses/:id/documents/:documentId`: the title students will read. */
export function useRenameDocument(courseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api<CourseDocument>(`${base(courseId)}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(CourseDocumentPatch.parse({ title })),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: courseLibraryKey(courseId) }),
  });
}

/** `DELETE /courses/:id/documents/:documentId`: the uploader's or an owner's. */
export function useDeleteDocument(courseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`${base(courseId)}/${id}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: courseLibraryKey(courseId) }),
  });
}

/** `PATCH /admin/courses/:id/documents-quota`: an administrator's alone. */
export function useSetDocumentsQuota(courseId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (quotaBytes: number) =>
      api<DocumentsQuotaPatch>(`/app/api/admin/courses/${courseId}/documents-quota`, {
        method: "PATCH",
        body: JSON.stringify(DocumentsQuotaPatch.parse({ quotaBytes })),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: courseLibraryKey(courseId) }),
  });
}
