/**
 * The concepts a course declares (F-ORG-12, ADR-081 §8), a section of the
 * course's Settings tab: a plain list, sorted by label by the server, no
 * order to keep. Staff only — it is read on the course's own routes and
 * never in a student payload.
 *
 * The course's owners edit it with the question editor's own picker
 * (`ConceptPicker`): a pick or a removal saves the whole set at once, and a
 * concept created there is `proposed`, as anywhere. An assistant reads the
 * names as plain text under one line saying whose they are to change — no
 * disabled controls. The section has no primary: a settings tab has none.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen } from "lucide-react";

import type { CourseConcepts as CourseConceptsData, CourseConceptsPut } from "@quiz/contracts";

import { api } from "../api";
import { ConceptNames } from "../concepts/refs";
import { ConceptPicker } from "../concepts/ConceptPicker";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { courseConceptsKey, courseKey } from "../queryKeys";
import { Card, QueryError, SectionHeading, Skeleton } from "../ui";

export function CourseConcepts({ courseId, canManage }: { courseId: string; canManage: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const list = useQuery<CourseConceptsData>({
    queryKey: courseConceptsKey(courseId),
    queryFn: () => api(`/app/api/courses/${courseId}/concepts`),
  });
  const save = useMutation({
    mutationFn: (conceptIds: string[]) =>
      api<CourseConceptsData>(`/app/api/courses/${courseId}/concepts`, {
        method: "PUT",
        body: JSON.stringify({ conceptIds } satisfies CourseConceptsPut),
      }),
    onSuccess: (data) => qc.setQueryData(courseConceptsKey(courseId), data),
    onSettled: () => {
      // The course detail carries the list too (MCP, assistant): refetch it with this one.
      void qc.invalidateQueries({ queryKey: courseConceptsKey(courseId) });
      void qc.invalidateQueries({ queryKey: courseKey(courseId), exact: true });
    },
    onError: toastError("error.save"),
  });

  const concepts = list.data?.concepts ?? [];
  // While a save is in flight the field shows what was asked, not the old list.
  const ids = save.isPending ? save.variables : concepts.map((c) => c.id);

  return (
    <section className="space-y-3">
      <SectionHeading icon={BookOpen} title={t("courses.settings.concepts")} />
      {list.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : list.isError ? (
        <QueryError title={t("courses.concepts.loadFailed")} query={list} />
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
