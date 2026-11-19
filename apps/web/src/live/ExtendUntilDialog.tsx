/**
 * "Extend until a date" (F-LIVE-11, ADR-086 amendment 2026-11-19): the
 * class's end moved to a chosen instant while the evaluation runs, its
 * configuration being locked (#86). Opened from the live header's Extend
 * menu, only where `@quiz/domain#extendUntilRefusal` lets it.
 *
 * One field, prefilled with the current end in the reader's own time; the
 * one action stays off until the time is later than the current end and
 * than now, which the field says under it once the teacher has touched it.
 * The server decides again on the row it writes: its refusal is said here.
 */
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";

import type { ExtendUntilBody, ExtendResponse } from "@quiz/contracts";

import { api, wordedRefusal } from "../api";
import { useT } from "../i18n";
import {
  Field,
  FieldError,
  fieldErrorProps,
  FormDialog,
  FormError,
  fromLocalInput,
  isoDateTime,
  toLocalInput,
} from "../ui";

export function ExtendUntilDialog({
  evaluationId,
  closesAt,
  clock,
  onDone,
  onClose,
}: {
  evaluationId: string;
  /** The class's end as the dashboard has it now. */
  closesAt: string;
  /** Server time: an end gone by (an accommodated student still working) is no floor. */
  clock: () => number;
  /** The extension landed: refresh what shows the end. */
  onDone: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const errorId = useId();
  const initial = toLocalInput(closesAt);
  const [local, setLocal] = useState(initial);
  const until = fromLocalInput(local);
  const floor = new Date(Math.max(Date.parse(closesAt), clock())).toISOString();
  const later = until !== null && Date.parse(until) > Date.parse(floor);
  // Said once the teacher has changed the field: the current end it opens on is not a mistake.
  const tooEarly =
    local !== initial && !later ? t("live.extendUntil.notLater", { when: isoDateTime(floor) }) : null;

  const extend = useMutation({
    mutationFn: (body: ExtendUntilBody) =>
      api<ExtendResponse>(`/app/api/evaluations/${evaluationId}/extend`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <FormDialog
      title={t("live.extendUntil.title")}
      onClose={onClose}
      submitLabel={t("live.extend")}
      submitting={extend.isPending}
      canSubmit={later}
      onSubmit={() => until !== null && extend.mutate({ until, scope: "all" })}
      error={
        <FormError
          error={extend.error}
          describe={(error) =>
            wordedRefusal(
              error,
              {
                until_not_later: "live.extendUntil.tooEarly",
                extend_until_refused: "live.extendUntil.refused",
                evaluation_finished: "live.extendUntil.refused",
              },
              t,
            )
          }
        />
      }
    >
      <div className="flex flex-col gap-1">
        <Field
          type="datetime-local"
          label={t("live.extendUntil.field")}
          description={t("live.extendUntil.desc", { when: isoDateTime(closesAt) })}
          value={local}
          required
          autoFocus
          onChange={(e) => setLocal(e.target.value)}
          {...fieldErrorProps(errorId, tooEarly)}
        />
        <FieldError id={errorId}>{tooEarly}</FieldError>
      </div>
    </FormDialog>
  );
}
