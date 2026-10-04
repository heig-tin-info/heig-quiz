import { Plus, RotateCw } from "lucide-react";

import type { GroupSetSummary } from "@quiz/contracts";

import { useT, type TFunction } from "../i18n";
import { useToast } from "../notify";
import { Button, FieldError, fieldErrorProps, Select, Skeleton } from "../ui";
import { useClassroomGroupSets, useCreateGroupSet } from "./api";
import { groupRefusalMessage } from "./groupRules";

/** A set as the picker lists it: its name, its groups, the students not placed yet (ADR-070 §7). */
export function setLabel(set: GroupSetSummary, t: TFunction): string {
  const groups = t(set.groups === 1 ? "groups.count.groups.one" : "groups.count.groups", { n: set.groups });
  const unplaced = t(set.unplaced === 1 ? "groups.count.unplaced.one" : "groups.count.unplaced", { n: set.unplaced });
  return `${set.name} — ${groups} · ${unplaced}`;
}

/**
 * The group set a group project follows (ADR-070 §7): the classroom's sets,
 * and **Create new groups**, which makes an empty set and picks it without
 * leaving the screen (the new project's draft lives in the browser; the
 * set's page is a link away once the project exists). Used by the new
 * project form and by a draft's page.
 */
export function GroupSetPicker({
  id,
  classroomId,
  value,
  onChange,
  disabled,
  message,
}: {
  /** The select's DOM id: where a refusal points the focus. */
  id: string;
  classroomId: string;
  value: string | null;
  onChange: (setId: string | null) => void;
  disabled?: boolean;
  /** A refusal said under the field. */
  message?: string;
}) {
  const t = useT();
  const toast = useToast();
  const sets = useClassroomGroupSets(classroomId);
  const create = useCreateGroupSet(classroomId, (created) => {
    onChange(created.set.id);
    toast(t("project.groupSet.created"), "success");
  });
  // A set that left the list (deleted meanwhile) is no choice: the field reads empty.
  const known = value !== null && (sets.data ?? []).some((s) => s.id === value);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-end gap-2">
        {sets.isLoading ? (
          <Skeleton className="h-[34px] w-72" />
        ) : (
          <Select
            id={id}
            // The row or the section around it says "Group set" already.
            aria-label={t("project.groupSet")}
            value={known ? value : ""}
            disabled={disabled || sets.isError}
            onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
            {...fieldErrorProps(id, message)}
          >
            <option value="">{t("project.groupSet.pick")}</option>
            {sets.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {setLabel(s, t)}
              </option>
            ))}
          </Select>
        )}
        <Button
          variant="secondary"
          disabled={disabled}
          loading={create.isPending}
          onClick={() => create.mutate({}, { onError: (error) => toast(groupRefusalMessage(error, t), "error") })}
        >
          <Plus /> {t("project.groupSet.create")}
        </Button>
      </div>
      <FieldError id={id}>{message}</FieldError>
      {sets.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <FieldError id={`${id}-load`}>{t("groups.loadFailed")}</FieldError>
          <Button size="sm" variant="ghost" loading={sets.isFetching} onClick={() => void sets.refetch()}>
            <RotateCw /> {t("common.retry")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
