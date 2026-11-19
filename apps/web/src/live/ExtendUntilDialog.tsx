/**
 * "Extend until a date" (F-LIVE-11, ADR-086 amendment 2026-11-19): the
 * class's end moved to a chosen instant while the evaluation runs, its
 * configuration being locked (#86). Opened from the live header's Extend
 * menu, only where `@quiz/domain#extendUntilRefusal` lets it.
 *
 * One field, prefilled with the current end in the reader's own time; the
 * one action stays off until `untilRefusal` takes the time (later than the
 * current end and than now, within the horizon), which the field says under
 * it once the teacher has touched it. The server decides again on the row it
 * writes: its refusal is said here.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { ExtendUntilBody, ExtendResponse } from "@quiz/contracts";
import { extendUntilWindow, untilRefusal } from "@quiz/domain";

import { api, refusalCodeOf, wordedRefusal } from "../api";
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

/** The one field of the dialog: its error is tied to it by this id. */
const FIELD_ID = "extend-until";

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
  const initial = toLocalInput(closesAt);
  const [local, setLocal] = useState(initial);
  const until = fromLocalInput(local);
  const end = new Date(closesAt);
  const now = new Date(clock());
  const { after, latest } = extendUntilWindow(end, now);
  const refusal = until === null ? "not_later" : untilRefusal(new Date(until), end, now);
  /** The words of a refused time, the field's and the server's (`until_not_later`, `until_too_far`) alike. */
  const refused = (reason: "not_later" | "too_far") =>
    reason === "too_far"
      ? t("live.extendUntil.tooFar", { when: isoDateTime(latest.toISOString()) })
      : t("live.extendUntil.notLater", { when: isoDateTime(after.toISOString()) });
  // Said once the teacher has changed the field: the current end it opens on is not a mistake.
  const error = local === initial || refusal === null ? null : refused(refusal);

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
      canSubmit={until !== null && refusal === null}
      onSubmit={() => until !== null && extend.mutate({ until })}
      error={
        <FormError
          error={extend.error}
          describe={(e) => {
            const code = refusalCodeOf(e);
            if (code === "until_not_later") return refused("not_later");
            if (code === "until_too_far") return refused("too_far");
            return wordedRefusal(
              e,
              { extend_until_refused: "live.extendUntil.refused", evaluation_finished: "live.extendUntil.refused" },
              t,
            );
          }}
        />
      }
    >
      <div className="flex flex-col gap-1">
        <Field
          id={FIELD_ID}
          type="datetime-local"
          label={t("live.extendUntil.field")}
          description={t("live.extendUntil.desc", { when: isoDateTime(closesAt) })}
          value={local}
          min={toLocalInput(after.toISOString())}
          max={toLocalInput(latest.toISOString())}
          required
          onChange={(e) => setLocal(e.target.value)}
          {...fieldErrorProps(FIELD_ID, error)}
        />
        <FieldError id={FIELD_ID}>{error}</FieldError>
      </div>
    </FormDialog>
  );
}
