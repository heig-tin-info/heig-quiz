/**
 * The catalog of conditions of a course (F-ORG-16, ADR-079 §5), a section of
 * the course's Settings tab: the conditions its staff announces often, which
 * an evaluation's or a template's conditions pick from.
 *
 * The course's owners manage it (ADR-079 §5, amended 2026-10-09): the
 * section's own "Add condition" (a secondary: a settings tab has no
 * primary), the rows' text and kind, their menu to move or archive them, and
 * the archived entries waiting collapsed under the list behind a quiet "Show
 * archived" disclosure, each with its Restore. An entry is archived, never
 * deleted. An assistant reads the active entries as plain text — no
 * disabled controls — under one line saying whose they are to change; they
 * still tick them in an evaluation's conditions.
 *
 * The row is the evaluation editor's own (`ConditionRow`). The snapshot rule
 * is said once, under the list: picking an entry copies its words, so
 * nothing done here changes an evaluation or a template that already holds
 * them.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, ListChecks, Plus } from "lucide-react";
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
import { Button, Card, Field, FieldLabel, FormDialog, QueryError, SectionHeading, Segmented, Skeleton } from "../ui";
import { useCourseConditions } from "./parts";

/** One write to the catalog: a path under `/courses/:id/conditions`, a method, a body. */
interface CatalogWrite {
  path?: string;
  method: string;
  body?: unknown;
}

export function CourseConditions({ courseId, canManage }: { courseId: string; canManage: boolean }) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={ListChecks}
        title={t("courses.settings.conditions")}
        actions={
          canManage ? (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
              <Plus /> {t("courses.conditions.add")}
            </Button>
          ) : null
        }
      />
      <Catalog courseId={courseId} canManage={canManage} adding={adding} onAdding={setAdding} />
    </section>
  );
}

function Catalog({
  courseId,
  canManage,
  adding,
  onAdding,
}: {
  courseId: string;
  canManage: boolean;
  /** The section's "Add condition" was pressed: its dialog is open. */
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

  if (catalog.isLoading) return <Skeleton className="h-40 w-full" />;
  if (catalog.isError) {
    return (
      <QueryError title={t("courses.conditions.loadFailed")} query={catalog} />
    );
  }
  const rows = catalog.data ?? [];
  const active = rows.filter((r) => r.archivedAt === null);
  const archived = canManage ? rows.filter((r) => r.archivedAt !== null) : [];
  const move = (i: number, delta: -1 | 1) => {
    const ids = active.map((r) => r.id);
    [ids[i], ids[i + delta]] = [ids[i + delta]!, ids[i]!];
    write.mutate({ path: "/order", method: "PUT", body: { ids } satisfies CourseConditionOrder });
  };

  return (
    <>
      <Card className="px-5">
        {active.length === 0 ? (
          // Words, not a second button: "Add condition" is in the heading.
          <p className="py-3 text-sm text-fg-muted">
            {t(canManage ? "courses.conditions.empty" : "courses.conditions.emptyReadOnly")}
          </p>
        ) : canManage ? (
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
        ) : (
          <ol className="divide-y divide-line">
            {active.map((row) => (
              <li key={row.id} className="py-2.5">
                <p className="text-xs font-medium text-fg-faint">{t(`conditions.kind.${row.kind}`)}</p>
                <p className="text-sm [overflow-wrap:anywhere]">{row.text}</p>
              </li>
            ))}
          </ol>
        )}
        {archived.length > 0 ? (
          <div className="border-t border-line py-2">
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
      <p className="text-[13px] text-fg-muted">
        {t(canManage ? "courses.conditions.snapshot" : "courses.conditions.ownerOnly")}
      </p>

      {adding ? (
        <AddConditionModal
          submitting={write.isPending}
          onCreate={(body) =>
            write.mutate({ method: "POST", body }, { onSuccess: () => onAdding(false) })
          }
          onClose={() => onAdding(false)}
        />
      ) : null}
    </>
  );
}

/**
 * A new entry of the catalog: its kind and its text, two fields, so a
 * `Modal`. The write is the section's own; a refusal is its toast, and the
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
