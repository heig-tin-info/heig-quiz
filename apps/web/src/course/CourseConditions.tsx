/**
 * The course page's Conditions tab (F-ORG-16, ADR-079 §5): the catalog of
 * the conditions its staff announces often, which an evaluation's or a
 * template's conditions pick from. Every member manages it (ADR-068 §3), so
 * the header's "Add condition" is every member's, and so are the rows.
 *
 * A row is the evaluation editor's own (`ConditionRow`): the kind, the text
 * written when the field is left, and a menu to move it or archive it. An
 * entry is archived, never deleted; the archived ones wait collapsed under
 * the list, behind a quiet "Show archived" disclosure, as a course's archived
 * classrooms do, each with its Restore.
 *
 * The snapshot rule is said once, under the list: picking an entry copies
 * its words, so nothing done here changes an evaluation or a template that
 * already holds them.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import {
  ConditionKind,
  CourseConditionCreate,
  type CourseConditionOrder,
  type CourseConditionPatch,
} from "@quiz/contracts";
import { MAX_CONDITION_LENGTH } from "@quiz/domain";

import { api } from "../api";
import { ConditionRow, moveActions } from "../evaluation/ConditionsSetting";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { courseConditionsKey } from "../queryKeys";
import { Button, Card, Field, FieldLabel, FormDialog, QueryError, Segmented, Skeleton } from "../ui";
import { useCourseConditions } from "./parts";

/** One write to the catalog: a path under `/courses/:id/conditions`, a method, a body. */
interface CatalogWrite {
  path?: string;
  method: string;
  body?: unknown;
}

export function CourseConditions({
  courseId,
  adding,
  onAdding,
}: {
  courseId: string;
  /** The header's "Add condition" was pressed: its dialog is open. */
  adding: boolean;
  onAdding: (open: boolean) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const [showArchived, setShowArchived] = useState(false);
  const catalog = useCourseConditions(courseId);
  const base = `/app/api/courses/${courseId}/conditions`;
  const write = useMutation({
    mutationFn: ({ path = "", method, body }: CatalogWrite) =>
      api(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    onSettled: () => qc.invalidateQueries({ queryKey: courseConditionsKey(courseId) }),
    onError: toastError("error.save"),
  });

  if (catalog.isLoading) return <Skeleton className="h-40 w-full max-w-3xl" />;
  if (catalog.isError) {
    return (
      <div className="max-w-3xl">
        <QueryError
          title={t("courses.conditions.loadFailed")}
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
          retrying={catalog.isFetching}
        />
      </div>
    );
  }
  const rows = catalog.data ?? [];
  const active = rows.filter((r) => r.archivedAt === null);
  const archived = rows.filter((r) => r.archivedAt !== null);
  const move = (i: number, delta: -1 | 1) => {
    const ids = active.map((r) => r.id);
    [ids[i], ids[i + delta]] = [ids[i + delta]!, ids[i]!];
    write.mutate({ path: "/order", method: "PUT", body: { ids } satisfies CourseConditionOrder });
  };

  return (
    <div className="max-w-3xl space-y-3">
      <Card className="px-4">
        {active.length === 0 ? (
          // Words, not a second button: "Add condition" is in the header.
          <p className="py-3 text-sm text-fg-muted">{t("courses.conditions.empty")}</p>
        ) : (
          <ol className="divide-y divide-line">
            {active.map((row, i) => (
              <ConditionRow
                key={`${row.id}:${row.kind}:${row.text}`}
                index={i}
                condition={row}
                disabled={false}
                onChange={(next) => {
                  const body: CourseConditionPatch = { kind: next.kind, text: next.text };
                  write.mutate({ path: `/${row.id}`, method: "PATCH", body });
                }}
                actions={[
                  ...moveActions(t, i, active.length, move),
                  {
                    label: t("courses.conditions.archive"),
                    icon: Archive,
                    onSelect: () => write.mutate({ path: `/${row.id}/archive`, method: "POST" }),
                  },
                ]}
              />
            ))}
          </ol>
        )}
        {archived.length > 0 ? (
          <div className="border-t border-line py-2">
            {/* A quiet disclosure: the tab's accent belongs to "Add condition". */}
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showArchived}
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? <ChevronDown /> : <ChevronRight />}
              {t("courses.conditions.showArchived", { n: archived.length })}
            </Button>
            {showArchived ? (
              <ul className="mt-1 divide-y divide-line">
                {archived.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-fg-faint">{t(`conditions.kind.${row.kind}`)}</p>
                      <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{row.text}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => write.mutate({ path: `/${row.id}/unarchive`, method: "POST" })}
                    >
                      <ArchiveRestore /> {t("courses.conditions.restore")}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Card>
      <p className="text-[13px] text-fg-muted">{t("courses.conditions.snapshot")}</p>

      {adding ? (
        <AddConditionModal
          submitting={write.isPending}
          onCreate={(body) =>
            write.mutate({ method: "POST", body }, { onSuccess: () => onAdding(false) })
          }
          onClose={() => onAdding(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * A new entry of the catalog: its kind and its text, two fields, so a
 * `Modal`. The write is the tab's own; a refusal is its toast, and the
 * dialog stays open on it.
 */
function AddConditionModal({
  submitting,
  onCreate,
  onClose,
}: {
  submitting: boolean;
  onCreate: (body: CourseConditionCreate) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [kind, setKind] = useState<ConditionKind>("allowed");
  const [text, setText] = useState("");
  const body = CourseConditionCreate.safeParse({ kind, text });
  return (
    <FormDialog
      title={t("courses.conditions.add")}
      onClose={onClose}
      onSubmit={() => body.success && onCreate(body.data)}
      submitLabel={t("common.create")}
      submitting={submitting}
      canSubmit={body.success}
    >
      <fieldset className="space-y-1.5">
        <legend className="mb-1.5">
          <FieldLabel>{t("eval.conditions.kind")}</FieldLabel>
        </legend>
        <Segmented
          name="condition-kind"
          label={t("eval.conditions.kind")}
          value={kind}
          onChange={setKind}
          options={ConditionKind.options.map((value) => ({ value, label: t(`conditions.kind.${value}`) }))}
        />
      </fieldset>
      <Field
        label={t("eval.conditions.text")}
        required
        fullWidth
        autoFocus
        maxLength={MAX_CONDITION_LENGTH}
        placeholder={t("eval.conditions.placeholder")}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </FormDialog>
  );
}
