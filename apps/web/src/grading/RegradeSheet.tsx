import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useId, useState } from "react";

import type { GradingQueueItem, ItemVersions, VersionRow } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { gradingItemVersionsKey } from "../queryKeys";
import { Alert, Badge, cx, ErrorText, FormError, isoDateTime, QueryError, RadioRow, Skeleton, Textarea } from "../ui";
import { useGradingInvalidate } from "./useGradingInvalidate";
import { ValidatedSheet } from "./ValidatedSheet";

/**
 * The version a regrade starts on (issue #106): the newest one when it is
 * newer than the frozen one and not deprecated — "I just fixed the question,
 * regrade with the fix" is the usual reason to be here — else the frozen one.
 * The server lists the versions newest first.
 */
export function defaultVersion(data: ItemVersions): number {
  const newest = data.versions.find((v) => v.deprecatedAt === null);
  return newest && newest.number > data.frozenNumber ? newest.number : data.frozenNumber;
}

/**
 * F-GRADE-06: one question, graded again across every attempt, optionally
 * against a newer published version. The note is mandatory because it is
 * what every new grading carries in its `regradeNote`, and what the history
 * shows a month later when someone asks why a grade moved.
 *
 * The version is picked from the list of the question's published versions,
 * each with its change note — the teacher reads WHAT changed and never has to
 * know a number. The list comes through the evaluation item, not the pool:
 * whoever may grade may always see what they grade against.
 *
 * Once the results are released, the sheet says before anything is sent what
 * the re-grade will do to them (F-GRADE-09): the students' grades change, and
 * the results are marked "modified after publication".
 */
export function RegradeSheet({
  evaluationId,
  item,
  released,
  onClose,
}: {
  evaluationId: string;
  item: GradingQueueItem;
  /** The evaluation's results are released: the re-grade will change them. */
  released: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const invalidateGrading = useGradingInvalidate(evaluationId);
  const [note, setNote] = useState("");
  /** The teacher's pick; `null` until they make one, and the default stands. */
  const [picked, setPicked] = useState<number | null>(null);
  const noteInvalid = note.trim() === "";

  const versions = useQuery<ItemVersions>({
    queryKey: gradingItemVersionsKey(evaluationId, item.id),
    queryFn: () => api(`/app/api/evaluations/${evaluationId}/items/${item.id}/versions`),
  });
  const chosen = picked ?? (versions.data ? defaultVersion(versions.data) : null);
  // The frozen version is sent as NO version: an absent field keeps what the
  // evaluation froze, and the note does not claim a change of version.
  const target =
    chosen !== null && versions.data && chosen !== versions.data.frozenNumber ? chosen : null;

  const run = useMutation({
    mutationFn: () =>
      api(`/app/api/evaluations/${evaluationId}/items/${item.id}/regrade`, {
        method: "POST",
        body: JSON.stringify({
          note: note.trim(),
          ...(target === null ? {} : { toVersionNumber: target }),
        }),
      }),
    onSuccess: () => {
      invalidateGrading();
      toast(t("grading.regrade.started"), "progress");
      onClose();
    },
  });

  return (
    <ValidatedSheet
      title={t("grading.regrade.title")}
      subtitle={t("grading.regrade.subtitle")}
      onClose={onClose}
      submitLabel={t("grading.regrade.action")}
      submitting={run.isPending}
      // Not before the list is in: a submit then would quietly keep the frozen
      // version while the sheet was about to preselect a newer one.
      invalid={noteInvalid || versions.isLoading}
      onSubmit={() => run.mutate()}
      error={<FormError error={run.error} title={t("grading.regrade.failed")} />}
    >
      {(touched) => (
        <>
          <p className="text-sm text-fg-muted">
            {/* 0-based on the wire; every screen numbers questions from 1. */}
            {item.position + 1}. {item.internalName}
          </p>
          {released ? (
            <Alert tone="warning" icon={AlertTriangle} title={t("grading.regrade.releasedTitle")}>
              {t("grading.regrade.releasedBody")}
            </Alert>
          ) : null}
          <div className="space-y-1.5">
            <Textarea
              label={t("grading.regrade.note")}
              placeholder={t("grading.regrade.notePlaceholder")}
              value={note}
              required
              autoFocus
              onChange={(e) => setNote(e.target.value)}
              aria-invalid={touched && noteInvalid}
            />
            {touched && noteInvalid ? (
              <ErrorText>{t("grading.regrade.noteRequired")}</ErrorText>
            ) : null}
          </div>
          <VersionPicker state={versions} chosen={chosen} onPick={setPicked} />
        </>
      )}
    </ValidatedSheet>
  );
}

/** The published versions as one radio group, newest first. */
function VersionPicker({
  state,
  chosen,
  onPick,
}: {
  state: UseQueryResult<ItemVersions>;
  chosen: number | null;
  onPick: (n: number) => void;
}) {
  const t = useT();
  const name = useId();
  const hintId = useId();
  const data = state.data;
  return (
    <fieldset className="space-y-1.5" aria-describedby={hintId} aria-busy={state.isLoading}>
      <legend className="text-[13px] font-medium text-fg">{t("grading.regrade.version")}</legend>
      <p id={hintId} className="text-xs text-fg-muted">
        {t("grading.regrade.versionHint")}
      </p>
      {state.isLoading ? (
        <div className="space-y-2 pt-1">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : state.isError ? (
        <QueryError
          title={t("grading.regrade.versionsFailed")}
          error={state.error}
          onRetry={() => void state.refetch()}
          retrying={state.isFetching}
          fallback={t("error.server")}
        />
      ) : data ? (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {data.versions.map((v) => (
            <li key={v.number}>
              <VersionOption
                name={name}
                version={v}
                frozen={v.number === data.frozenNumber}
                checked={v.number === chosen}
                onPick={onPick}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}

function VersionOption({
  name,
  version: v,
  frozen,
  checked,
  onPick,
}: {
  name: string;
  version: VersionRow;
  frozen: boolean;
  checked: boolean;
  onPick: (n: number) => void;
}) {
  const t = useT();
  return (
    <RadioRow name={name} value={v.number} checked={checked} onPick={onPick}>
      <span className="block space-y-0.5">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-semibold tabular-nums text-fg">
            {t("question.versions.number", { n: v.number })}
          </span>
          {frozen ? <Badge tone="zinc">{t("grading.regrade.frozen")}</Badge> : null}
          {v.deprecatedAt !== null ? (
            <Badge tone="amber">{t("question.versions.deprecated")}</Badge>
          ) : null}
          <time dateTime={v.publishedAt} className="ml-auto text-xs tabular-nums text-fg-faint">
            {isoDateTime(v.publishedAt)}
          </time>
        </span>
        <span className={cx("block text-[13px]", v.changeNote ? "text-fg-muted" : "text-fg-faint")}>
          {v.changeNote || t("grading.regrade.noChangeNote")}
        </span>
      </span>
    </RadioRow>
  );
}
