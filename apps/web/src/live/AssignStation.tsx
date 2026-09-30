import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import type { KioskAssign, PairApproved } from "@quiz/contracts";
import { formatUserCode, normalizeUserCode } from "@quiz/domain";

import { ApiError, api } from "../api";
import { useT } from "../i18n";
import { Alert, Button, Field, Modal } from "../ui";

/**
 * The supervisor's fallback (ADR-051 §7): a student without a phone reads
 * the code on the station's screen, and the supervisor approves it for them
 * from the dashboard — the same pairing as `/pair`. One field, so a modal;
 * one action, Assign. The station's label comes back with the approval and
 * is said in the toast: the supervisor is standing at the station, reading
 * its code, so there is nothing to compare before confirming.
 */
export function AssignStationDialog({
  evaluationId,
  userId,
  name,
  onDone,
  onClose,
}: {
  evaluationId: string;
  userId: string;
  /** The row's name as the grid shows it. */
  name: string;
  onDone: (label: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [typed, setTyped] = useState("");
  const [malformed, setMalformed] = useState(false);
  const assign = useMutation({
    mutationFn: (userCode: string) =>
      api<PairApproved>(`/app/api/evaluations/${evaluationId}/kiosk-assign`, {
        method: "POST",
        body: JSON.stringify({ userCode, userId } satisfies KioskAssign),
      }),
    onSuccess: (data) => onDone(data.station.label),
  });
  const status = assign.error instanceof ApiError ? assign.error.status : null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const code = normalizeUserCode(typed);
    setMalformed(code === null);
    if (code !== null) assign.mutate(code);
  };

  return (
    <Modal
      title={t("live.assign.title", { name })}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="assign-station" variant="primary" loading={assign.isPending}>
            {t("live.assign.submit")}
          </Button>
        </>
      }
    >
      <form id="assign-station" className="flex flex-col gap-3" onSubmit={submit} noValidate>
        <p className="text-sm text-fg-muted">{t("live.assign.body", { name })}</p>
        {assign.isError ? (
          <Alert tone={status === 404 ? "warning" : "danger"}>
            {status === 404
              ? t("live.assign.invalid")
              : status === 409
                ? t("live.assign.refused", { name })
                : status === 429
                  ? t("pair.limited")
                  : t("live.controlFailed")}
          </Alert>
        ) : null}
        <Field
          label={t("live.assign.code")}
          fullWidth
          value={typed}
          onChange={(e) => {
            setTyped(formatUserCode(e.target.value));
            setMalformed(false);
          }}
          autoFocus
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="BCDF-GHJK"
          aria-invalid={malformed || undefined}
          className="font-mono text-lg tracking-[0.08em]"
        />
        <p className={malformed ? "-mt-1 text-[13px] text-danger" : "-mt-1 text-[13px] text-fg-faint"}>
          {t(malformed ? "pair.code.malformed" : "pair.code.hint")}
        </p>
      </form>
    </Modal>
  );
}
