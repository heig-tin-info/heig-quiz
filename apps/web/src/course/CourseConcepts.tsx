/**
 * The concepts a course declares (F-ORG-12, ADR-081 §8), a section of the
 * course's Settings tab: a plain list, sorted by label by the server, no
 * order to keep. Staff only — it is part of the course detail
 * (`useCourseDetail`, like the linked pools) and never of a student payload.
 *
 * The course's owners edit it with the question editor's own picker
 * (`ConceptPicker`): a pick or a removal saves the whole set at once, and the
 * answer (the new list, by label) replaces the course detail's. A concept
 * created there is `proposed`, as anywhere. An assistant reads the names as
 * plain text under one line saying whose they are to change — no disabled
 * controls. The section has no primary: a settings tab has none.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";

import type { CourseConcepts as CourseConceptsData, CourseConceptsPut, CourseDetail } from "@quiz/contracts";

import { api } from "../api";
import { ConceptNames } from "../concepts/refs";
import { ConceptPicker } from "../concepts/ConceptPicker";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { courseKey } from "../queryKeys";
import { Card, QueryError, SectionHeading, Skeleton } from "../ui";
import { useCourseDetail } from "./parts";

export function CourseConcepts({ courseId, canManage }: { courseId: string; canManage: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const detail = useCourseDetail(courseId);
  const save = useMutation({
    mutationFn: (conceptIds: string[]) =>
      api<CourseConceptsData>(`/app/api/courses/${courseId}/concepts`, {
        method: "PUT",
        body: JSON.stringify({ conceptIds } satisfies CourseConceptsPut),
      }),
    onSuccess: ({ concepts }) =>
      qc.setQueryData<CourseDetail>(courseKey(courseId), (old) => (old ? { ...old, concepts } : old)),
    onSettled: () => qc.invalidateQueries({ queryKey: courseKey(courseId), exact: true }),
    onError: toastError("error.save"),
  });

  const concepts = detail.data?.concepts ?? [];
  // While a save is in flight the field shows what was asked, not the old list.
  const ids = save.isPending ? save.variables : concepts.map((c) => c.id);

  return (
    <section className="space-y-3">
      <SectionHeading icon={BookOpen} title={t("courses.settings.concepts")} />
      {detail.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : detail.isError ? (
        <QueryError title={t("courses.concepts.loadFailed")} query={detail} />
      ) : (
        <>
          <Card className="space-y-3 px-5 py-4">
            {canManage ? (
              <ConceptPicker value={ids} onChange={(next) => save.mutate(next)} label={t("courses.concepts.pickerLabel")} />
            ) : concepts.length === 0 ? (
              <p className="text-sm text-fg-muted">{t("courses.concepts.empty")}</p>
            ) : (
              <ConceptNames concepts={concepts} className="text-sm text-fg" />
            )}
          </Card>
          <p className="text-[13px] text-fg-muted">
            {t(canManage ? "courses.concepts.hint" : "courses.concepts.ownerOnly")}
          </p>
        </>
      )}
    </section>
  );
}
