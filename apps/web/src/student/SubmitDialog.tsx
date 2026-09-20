/**
 * "Hand in your answers?" (F-LIVE-10).
 *
 * A confirmation, so a dialog and not a sheet (DESIGN.md). It names the one
 * fact a student cannot see from the progress strip — how many questions are
 * still without an answer — because that is the reason to say "not yet", and
 * it says that nothing can be changed afterwards, because that is the reason
 * to say "yes" only once.
 *
 * The confirming button is `primary` and not `danger`: handing in is the
 * normal end of an attempt, not a destruction.
 */
import { useState } from "react";

import { useT } from "../i18n";
import { Button, Modal } from "../ui";

export function SubmitDialog({
  open,
  unanswered,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** Questions with no answer at all, as the player counts them. */
  unanswered: number;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  if (!open) return null;
  return (
    <Modal
      title={t("player.submit.title")}
      size="sm"
      onClose={busy ? () => {} : onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            autoFocus
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onConfirm().finally(() => setBusy(false));
            }}
          >
            {busy ? t("player.submitting") : t("player.submit.confirm")}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-fg-muted">
        {unanswered === 0
          ? t("player.submit.bodyAll")
          : unanswered === 1
            ? t("player.submit.bodyOne")
            : t("player.submit.body", { n: unanswered })}
      </p>
    </Modal>
  );
}
