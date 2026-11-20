/**
 * "Extend until a date" (F-LIVE-11, ADR-086 amendment 2026-11-19): the
 * class's end moved to a chosen instant while the evaluation runs, its
 * configuration being locked (#86). Opened from the live header's Extend
 * menu, only where `@quiz/domain#extendUntilRefusal` lets it.
 *
 * The shared `InstantDialog`, prefilled with the current end in the
 * reader's own time; `untilRefusal` decides on the server's clock (later
 * than the current end and than now, within the horizon). The server
 * decides again on the row it writes: its refusal is said here.
 */
import { useMutation } from "@tanstack/react-query";

import type { ExtendUntilBody, ExtendResponse } from "@quiz/contracts";
import { extendUntilWindow, untilRefusal } from "@quiz/domain";

import { api, refusalCodeOf, wordedRefusal } from "../api";
import { useT } from "../i18n";
import { FormError, InstantDialog, isoDateTime } from "../ui";

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
  const end = new Date(closesAt);
  const now = new Date(clock());
  const { after, latest } = extendUntilWindow(end, now);
  /** The words of a refused time, the field's and the server's (`until_not_later`, `until_too_far`) alike. */
  const refused = (reason: "not_later" | "too_far") =>
    reason === "too_far"
      ? t("live.extendUntil.tooFar", { when: isoDateTime(latest.toISOString()) })
      : t("live.extendUntil.notLater", { when: isoDateTime(after.toISOString()) });

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
    <InstantDialog
      title={t("live.extendUntil.title")}
      submitLabel={t("live.extend")}
      fieldLabel={t("live.extendUntil.field")}
      description={t("live.extendUntil.desc", { when: isoDateTime(closesAt) })}
      initial={closesAt}
      min={after.toISOString()}
      max={latest.toISOString()}
      refusal={(until) => {
        const reason = untilRefusal(new Date(until), end, now);
        return reason === null ? null : refused(reason);
      }}
      pending={extend.isPending}
      onSubmit={(until) => extend.mutate({ until })}
      onClose={onClose}
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
    />
  );
}
