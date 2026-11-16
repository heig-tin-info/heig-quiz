/**
 * The components of the mean of a course (F-GBOOK-07, ADR-131), a section of
 * the course's Settings tab: its weighted shares of the gradebook's mean
 * ("Labo", "Cours"), which the columns of its classrooms join from their
 * Grades tab.
 *
 * The course's owners manage them (ADR-131 §5): the section's own "Add
 * component" (a secondary: a settings tab has no primary), and each row's
 * Edit and Delete. Delete is offered only for a component no column is in;
 * one in use says so in its row instead. No reorder, no archive: the order is
 * the creation order. An assistant reads the list as plain text under one
 * line saying whose it is to change — no disabled controls, as the catalog of
 * conditions beside it.
 *
 * Three writes move the means of every classroom of the course, archived
 * ones included, and ask first: the first component (from then on a counted
 * activity in no component leaves the mean), a new weight, and a deletion.
 * A rename does not ask. The weights are relative, said once under the list;
 * nothing warns when they do not sum to 100.
 */
import { Pencil, Plus, Scale, Trash2 } from "lucide-react";
import { useState } from "react";

import { GradebookComponentName, GradebookWeight, type GradebookCourseComponent } from "@quiz/contracts";
import { COMPONENT_NAME_MAX, WEIGHT_DEFAULT } from "@quiz/domain";

import { useConfirm } from "../confirm";
import { gradebookRefusalMessage, useComponentWrites, useCourseComponents } from "../gradebook/api";
import { WeightField } from "../gradebook/ColumnSettingsFields";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { FormError } from "../queryError";
import { Actions, Button, Card, Field, FormDialog, QueryError, SectionHeading, Skeleton } from "../ui";

/** The dialog open: a new component, or one being edited. */
type Editing = { kind: "new" } | { kind: "edit"; component: GradebookCourseComponent };

export function CourseComponents({ courseId, canManage }: { courseId: string; canManage: boolean }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const list = useCourseComponents(courseId);
  const writes = useComponentWrites(courseId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<unknown>(null);
  const components = list.data ?? [];

  const open = (next: Editing) => {
    setError(null);
    setEditing(next);
  };

  /** The dialog's write: asks first when it moves the means, keeps the dialog open on a refusal. */
  const save = async (name: string, weight: number) => {
    if (!editing) return;
    const before = editing.kind === "edit" ? editing.component : null;
    if (before !== null && before.name === name && before.weight === weight) return setEditing(null);
    // The first component takes every counted column in none out of the mean; a weight moves every mean.
    const first = before === null && components.length === 0;
    const reweigh = before !== null && before.weight !== weight;
    const asked = first
      ? { title: t("courses.components.first.title"), message: t("courses.components.first.body"), confirmLabel: t("courses.components.add") }
      : reweigh
        ? { title: t("courses.components.reweigh.title"), message: t("courses.components.reweigh.body"), confirmLabel: t("courses.components.reweigh.confirm") }
        : null;
    if (asked && !(await confirm(asked))) return;
    setError(null);
    try {
      if (before === null) await writes.create({ name, weight });
      else await writes.patch(before.id, { ...(name !== before.name ? { name } : {}), ...(weight !== before.weight ? { weight } : {}) });
      setEditing(null);
    } catch (refusal) {
      setError(refusal);
    }
  };

  const remove = async (component: GradebookCourseComponent) => {
    const ok = await confirm({
      title: t("courses.components.delete.title", { name: component.name }),
      // The last one gone, the course is back to one mean over every counted column.
      message: components.length === 1 ? t("courses.components.delete.lastBody") : undefined,
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await writes.remove(component.id);
    } catch (refusal) {
      toast(gradebookRefusalMessage(refusal, t), "error");
    }
  };

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Scale}
        title={t("courses.settings.components")}
        actions={
          canManage && list.isSuccess ? (
            <Button variant="secondary" size="sm" onClick={() => open({ kind: "new" })}>
              <Plus /> {t("courses.components.add")}
            </Button>
          ) : null
        }
      />
      {list.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : list.isError ? (
        <QueryError title={t("courses.components.loadFailed")} query={list} />
      ) : (
        <>
          <Card className="px-5">
            {components.length === 0 ? (
              // Words, not a second button: "Add component" is in the heading.
              <p className="py-3 text-sm text-fg-muted">
                {t(canManage ? "courses.components.empty" : "courses.components.emptyReadOnly")}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {components.map((component) => (
                  <li key={component.id} className="flex items-center gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium [overflow-wrap:anywhere]">{component.name}</p>
                      <p className="text-[13px] text-fg-muted">
                        {t("gbook.weight", { weight: String(component.weight) })}
                        {canManage && component.inUse ? ` · ${t("courses.components.inUse")}` : null}
                      </p>
                    </div>
                    {canManage ? (
                      <Actions
                        label={t("courses.components.actions", { name: component.name })}
                        items={[
                          { label: t("common.edit"), icon: Pencil, onSelect: () => open({ kind: "edit", component }) },
                          ...(component.inUse
                            ? []
                            : [{ label: t("common.delete"), icon: Trash2, danger: true, onSelect: () => void remove(component) }]),
                        ]}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {canManage ? (
            components.length > 0 ? <p className="text-[13px] text-fg-muted">{t("courses.components.hint")}</p> : null
          ) : (
            <p className="text-[13px] text-fg-muted">{t("courses.components.ownerOnly")}</p>
          )}
        </>
      )}

      {editing ? (
        <ComponentDialog
          component={editing.kind === "edit" ? editing.component : null}
          submitting={writes.pending}
          error={error}
          onClose={() => setEditing(null)}
          onSubmit={(name, weight) => void save(name, weight)}
        />
      ) : null}
    </section>
  );
}

/**
 * A component's name and weight, two fields, so a `Modal`. The rule of the
 * weights stands under the weight, as in a column's settings dialog. The
 * write and its questions are the section's; a refusal (a name taken) is
 * said under the fields and the dialog stays open on it.
 */
function ComponentDialog({
  component,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  /** The component edited; null for a new one. */
  component: GradebookCourseComponent | null;
  submitting: boolean;
  /** The last refusal of the write, worded under the fields. */
  error: unknown;
  onClose: () => void;
  onSubmit: (name: string, weight: number) => void;
}) {
  const t = useT();
  const [name, setName] = useState(component?.name ?? "");
  const [weight, setWeight] = useState(component?.weight ?? WEIGHT_DEFAULT);
  const named = GradebookComponentName.safeParse(name);
  const valid = named.success && GradebookWeight.safeParse(weight).success;
  return (
    <FormDialog
      title={component ? t("courses.components.editTitle", { name: component.name }) : t("courses.components.add")}
      onClose={onClose}
      submitLabel={component ? t("common.save") : t("common.create")}
      submitting={submitting}
      canSubmit={valid}
      error={<FormError error={error} describe={(e) => gradebookRefusalMessage(e, t)} />}
      onSubmit={() => named.success && onSubmit(named.data, weight)}
    >
      <Field
        label={t("courses.components.name")}
        required
        fullWidth
        autoFocus
        maxLength={COMPONENT_NAME_MAX}
        placeholder={t("courses.components.namePlaceholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <WeightField
        hint={t("courses.components.weightHint")}
        defaultValue={component?.weight ?? WEIGHT_DEFAULT}
        onChange={setWeight}
      />
    </FormDialog>
  );
}
