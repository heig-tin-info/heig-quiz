/**
 * The course page's Conditions tab (F-ORG-16, ADR-079 §5): the catalog of
 * the conditions its staff announces often, which an evaluation's or a
 * template's conditions pick from. Every member manages it (ADR-068 §3), so
 * the header's "Add condition" is every member's, and so are the rows.
 *
 * A row is the evaluation editor's own (`ConditionRow`): the kind, the text
 * written when the field is left, and a menu to move it or archive it. An
 * entry is archived, never deleted; the archived ones wait collapsed under
 * the list, behind a "Show archived" chip, as a course's archived
 * classrooms do, each with its Restore.
 *
 * The snapshot rule is said once, under the list: picking an entry copies
 * its words, so nothing done here changes an evaluation or a template that
 * already holds them.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";

import {
  ConditionKind,
  CourseConditionCreate,
  type CourseConditionOrder,
  type CourseConditionPatch,
} from "@quiz/contracts";
import { MAX_CONDITION_LENGTH } from "@quiz/domain";

import { api } from "../api";
import { ConditionRow } from "../evaluation/ConditionsSetting";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { courseConditionsKey } from "../queryKeys";
import {
  Button,
  Card,
  Field,
  FieldLabel,
  FormDialog,
  FormError,
  QueryError,
  Segmented,
  Skeleton,
  ToggleChip,
} from "../ui";
import { useCourseConditions } from "./parts";

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
  const catalog = useCourseConditions(courseId, { archived: true });
  const base = `/app/api/courses/${courseId}/conditions`;
  const refresh = () => qc.invalidateQueries({ queryKey: courseConditionsKey(courseId) });
  const write = useMutation({
    mutationFn: ({ path = "", method, body }: { path?: string; method: string; body?: unknown }) =>
      api(`${base}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    onSettled: refresh,
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
                  ...(i > 0
                    ? [{ label: t("eval.conditions.moveUp"), icon: ArrowUp, onSelect: () => move(i, -1) }]
                    : []),
                  ...(i < active.length - 1
                    ? [{ label: t("eval.conditions.moveDown"), icon: ArrowDown, onSelect: () => move(i, 1) }]
                    : []),
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
          <div className="border-t border-line py-2.5">
            <div className="flex justify-end">
              <ToggleChip
                icon={Archive}
                tone="neutral"
                label={t("courses.conditions.showArchived", { n: archived.length })}
                pressed={showArchived}
                onToggle={() => setShowArchived((v) => !v)}
              />
            </div>
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

      {adding ? <AddConditionModal courseId={courseId} onClose={() => onAdding(false)} /> : null}
    </div>
  );
}

/** A new entry of the catalog: its kind and its text, two fields, so a `Modal`. */
function AddConditionModal({ courseId, onClose }: { courseId: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [kind, setKind] = useState<ConditionKind>("allowed");
  const [text, setText] = useState("");
  const body = CourseConditionCreate.safeParse({ kind, text });
  const create = useMutation({
    mutationFn: () =>
      api(`/app/api/courses/${courseId}/conditions`, { method: "POST", body: JSON.stringify(body.data) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: courseConditionsKey(courseId) });
      onClose();
    },
  });
  return (
    <FormDialog
      title={t("courses.conditions.add")}
      onClose={onClose}
      onSubmit={() => create.mutate()}
      submitLabel={t("common.create")}
      submitting={create.isPending}
      canSubmit={body.success}
      error={<FormError error={create.error} fallback={t("error.save")} />}
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
